# Backup Privacy Activation Execution v1

## Zweck

Die Backup-Privacy-Aktivierung ist in zwei bewusst getrennte Schichten aufgeteilt:

1. eine signierte, strikt pre-mutation Execution-Evidence,
2. einen bounded `.env`-Executor, der ausschließlich einen bereits verifizierten Plan v2 ausführen darf.

Der Executor verändert nur die im Plan gebundene Club-`.env`. Er startet, stoppt oder restarted **keine** Docker-/Compose-Dienste. Ein späterer Host-Cutover muss die tatsächlich laufenden Prozesse separat attestieren.

## Trust Chain

```text
signed restore/RTO drill evidence
  -> signed manual attestation
  -> signed reversible activation plan v2
  -> signed activation execution PENDING evidence
  -> bounded atomic .env replace
  -> post-write privacy policy attestation
  -> signed COMPLETED
       or signed ROLLBACK_STARTED -> exact rollback -> signed ROLLBACK_VERIFIED
```

Die Domains bleiben getrennt:

```text
masters:backup-privacy-activation-execution:v1
masters:backup-privacy-activation-executor:v1
```

## Durable PENDING Evidence

Vor jeder Mutation wird unter

```text
<execution-root>/<activationId>/activation-execution-pending.json
```

eine HMAC-signierte Evidence persistiert. Sie bindet insbesondere:

- `activationId` und deterministische `executionId`,
- Plan-Fingerprint und Plan-HMAC,
- SHA-256 des vollständigen Plan-Artefakts,
- absoluten `.env`-Pfad,
- signierten Pre- und Target-Fingerprint,
- Rollback-Strategie,
- `executionFingerprint`,
- die reversiblen Plan-v2-Safety-Flags,
- `executionMutationStarted=false`,
- `runtimeConfigurationChanged=false`,
- `activationExecuted=false`.

Das Evidence-Verzeichnis ist `0700`, Evidence-Dateien sind `0600`.

## Read-only Zustände

`backup-privacy-activation-execution.py check` vergleicht den tatsächlichen SHA-256 der `.env` mit den zwei signierten Plan-Fingerprints.

### `READY_TO_APPLY`

Die PENDING-Evidence ist gültig und die `.env` entspricht exakt `currentEnvFingerprint`. Nur aus diesem Zustand darf ein erster Replace beginnen.

### `READY_TO_VALIDATE`

Die PENDING-Evidence ist gültig und die `.env` entspricht bereits exakt `targetEnvFingerprint`. Das ist insbesondere der Crash-/Retry-Zustand nach einem erfolgreichen Replace, aber vor terminaler Validation. Ein Retry schreibt die Target-Bytes dann nicht erneut.

### Blocker

Ein Target-Zustand ohne vorherige PENDING-Evidence wird nicht nachträglich autorisiert. Jeder dritte Fingerprint ist `ENV_FINGERPRINT_DRIFT` und blockiert fail-closed.

## Bounded Executor

Der Executor lautet:

```bash
python3 infra/backup/execute-backup-privacy-activation.py \
  --plan /absolute/path/activation-....json \
  --pending /var/lib/master-diagnostics/backup-privacy-activation/<activationId>/activation-execution-pending.json \
  --key-file /absolute/path/backup-privacy.key \
  --env-file /absolute/path/.env
```

Die Standard-Abhängigkeiten werden aus dem Repository aufgelöst:

- `check-backup-privacy-activation-plan.py`,
- `backup-privacy-activation-execution.py`,
- `prepare-backup-privacy-activation-plan.py`,
- `check-backup-privacy-runtime.sh`.

Der letzte Wrapper ruft die kanonische TypeScript-Policy über `pnpm --silent privacy-capabilities:check` auf. Der Executor sourced die `.env` dabei **nicht**. Er parst nur die zehn bekannten `PRIVACY_*`-Variablen als plain `KEY=VALUE` und übergibt ausschließlich diese Werte an den Checker.

## Atomarer Target-Replace

Vor dem ersten Write werden Plan v2 und PENDING-Evidence erneut vollständig verifiziert. Die Zielbytes werden mit derselben `build_reversible_target_env`-Logik wie beim Plan v2 rekonstruiert und müssen sowohl den signierten `targetEnvFingerprint` als auch den signierten `rollbackDescriptor` reproduzieren.

Der Replace ist bounded:

1. aktueller Fingerprint muss unmittelbar vor der Mutation dem signierten Pre-State entsprechen,
2. temporäre Datei wird im selben Verzeichnis erzeugt,
3. Dateimodus wird erhalten; bei Root-Ausführung auch Owner/Group,
4. Target-Bytes werden geschrieben und `fsync`-t,
5. der Pre-Fingerprint wird unmittelbar vor dem Replace erneut geprüft,
6. `os.replace` führt den atomaren Wechsel aus,
7. das Parent-Verzeichnis wird `fsync`-t,
8. der resultierende Fingerprint muss exakt dem signierten Target entsprechen.

Ein `flock` im activation-gebundenen Evidence-Verzeichnis serialisiert konkurrierende Executor-Läufe.

## Post-Write-Attestation

Nach dem Target-Replace bzw. bei einem Retry aus `READY_TO_VALIDATE` läuft die Privacy-Capability-Attestation gegen die Werte der geschriebenen `.env`.

Erfolg erfordert mindestens:

```text
readyForIrreversibleProcessing=true
backupState=ENABLED
backupPolicyVersion=1.0.0
blockers=[]
```

Der SHA-256 der vollständigen JSON-Ausgabe wird in die terminale Evidence gebunden. Die Checker-Ausgabe selbst wird nicht als unbeschränktes Artefakt in die Activation-Evidence kopiert.

## Terminaler Erfolg

Nur nach erfolgreicher Post-Write-Attestation entsteht:

```text
activation-execution-completed.json
```

Das HMAC-signierte Artefakt bindet Plan, PENDING-Evidence, Pre-/Target-Fingerprints und den Attestation-SHA. Erst dieses Artefakt meldet `activationExecuted=true`.

Ein Retry mit gültigem `COMPLETED` und weiterhin passendem Target-Fingerprint ist idempotent `ALREADY_COMPLETED`.

## Rollback und Crash-Recovery

Schlägt die Post-Write-Attestation fehl, wird **vor** dem Rollback dauerhaft geschrieben:

```text
activation-execution-rollback-started.json
```

Dadurch bleibt der Fehlschlag sticky über Prozessabstürze hinweg. Ein späterer Retry darf selbst dann nicht erneut aktivieren, wenn der vorherige Lauf die `.env` bereits zurückgeschrieben hat, aber vor terminaler Rollback-Evidence abgestürzt ist.

Der Rollback rekonstruiert ausschließlich aus dem signierten Plan-v2-`rollbackDescriptor` die exakten ursprünglichen Bytes. Vor dem Replace muss deren SHA-256 `currentEnvFingerprint` entsprechen. Anschließend wird erneut die Privacy-Policy geprüft; für einen verifizierten Rollback werden mindestens verlangt:

```text
readyForIrreversibleProcessing=true
backupState=DISABLED
blockers=[]
```

Erst danach entsteht:

```text
activation-execution-rollback-verified.json
```

Ein Retry ist anschließend terminal `ALREADY_ROLLED_BACK` und kann diese Activation-ID nicht erneut aktivieren.

## Sicherheitsgrenzen

Der Executor:

- akzeptiert ausschließlich Plan v2 plus gültige PENDING-Evidence,
- bindet `.env`, Plan und Execution-ID gegeneinander,
- blockiert Symlinks und unsichere Dateirechte,
- führt unmittelbar vor jedem Replace einen Fingerprint-Recheck durch,
- verändert keine Nicht-Privacy-Bytes außerhalb der bereits im Plan signierten Transformation,
- kopiert keine übrigen `.env`-Secrets in terminale Evidence,
- führt kein Docker, Docker Compose oder Service-Restart aus,
- markiert einen Rollback nicht als erfolgreiche Aktivierung,
- lässt einen einmal begonnenen Rollback bei Retry nicht zurück in den Aktivierungspfad fallen.

## CI-Contract

`Backup Privacy Activation Executor Contract` prüft mit synthetischer, aber vollständig signierter Drill -> Attestation -> Plan-v2 -> PENDING-Kette:

- normalen atomaren Target-Replace und terminales `COMPLETED`,
- Erhaltung nicht betroffener `.env`-Zeilen,
- Retry nach simuliertem Crash unmittelbar nach Target-Write,
- fehlgeschlagene Post-Write-Attestation mit bytegenauem Rollback,
- Crash-Recovery nach Rollback-Write, aber vor terminaler Evidence,
- Verbot einer erneuten Aktivierung nach durablem `ROLLBACK_STARTED`,
- Drift-Blockade,
- HMAC-/Marker-Tamper-Blockade,
- `0700`/`0600`-Evidence-Grenzen,
- Abwesenheit von Docker-/Compose-Mutation.

Die reale `.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`. Der praktische Host-Restore-/RTO-Test und das Release-Gate bleiben ausdrücklich offen; synthetische CI-Evidence ersetzt diese Betriebsnachweise nicht.

## Nächster sicherer Slice

Nach diesem Executor ist die nächste Grenze **nicht** eine automatische Freigabe des Produktivbetriebs. Als nächstes muss der Host-Cutover die geänderte `.env` kontrolliert in die laufenden Dienste übernehmen, deren tatsächliche Runtime-Konfiguration attestieren und bei einem fehlgeschlagenen Restart/Healthcheck auf die verifizierte DISABLED-Konfiguration zurückkehren. Erst ein realer Wartungsfenster-Drill darf anschließend die offenen Restore-/RTO-Gates schließen.
