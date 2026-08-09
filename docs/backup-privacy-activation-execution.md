# Backup Privacy Activation Execution Evidence v1

## Zweck

Diese Schicht schließt die Lücke zwischen dem reversiblen Activation Plan v2 und einer späteren atomaren Änderung der Club-`.env`.

Sie erzeugt **vor jeder Mutation** eine durable, HMAC-signierte PENDING-Evidence und kann anschließend read-only unterscheiden, ob die `.env` noch exakt im signierten Ausgangszustand liegt oder ob ein zukünftiger atomarer Replace bereits erfolgt ist.

Dieser Slice ändert die `.env` selbst noch nicht und startet keine Docker-/Compose-Dienste neu.

## Trust Chain

Die Evidence akzeptiert ausschließlich einen bereits verifizierten Activation Plan v2:

```text
signed manual attestation
  -> signed reversible activation plan v2
  -> signed activation execution PENDING evidence
  -> actual .env fingerprint
```

Die neue Signing Domain lautet:

```text
masters:backup-privacy-activation-execution:v1
```

## Durable PENDING Evidence

Die Execution Evidence wird unter einem host-durablen Root pro `activationId` abgelegt:

```text
<execution-root>/<activationId>/activation-execution-pending.json
```

Der Root und das Activation-Verzeichnis werden auf `0700`, die Evidence-Datei auf `0600` gehalten.

Die Evidence bindet insbesondere:

- `activationId`,
- deterministische `executionId`,
- Plan-Fingerprint und Plan-HMAC,
- SHA-256 des vollständigen Plan-Artefakts,
- absoluten `.env`-Pfad,
- signierten Pre- und Target-Fingerprint,
- Rollback-Strategie,
- eigenes `executionFingerprint`,
- `pendingEvidenceRequiredBeforeMutation=true`,
- sämtliche reversiblen Plan-v2-Safety-Flags,
- `executionMutationStarted=false`,
- `runtimeConfigurationChanged=false`,
- `activationExecuted=false`.

Ein Retry verwendet exakt dieselbe Evidence wieder. Ein abweichendes bestehendes Artefakt blockiert über Fingerprint/HMAC/Binding.

## Zustandsmaschine

Der tatsächliche SHA-256 der `.env` wird gegen die beiden signierten Plan-Fingerprints geprüft.

### `READY_TO_APPLY`

Bedingungen:

- PENDING-Evidence ist vorhanden und verifiziert,
- `.env` entspricht exakt `currentEnvFingerprint`.

Dann gilt:

```text
activationMutationAllowed=true
postWriteValidationRequired=false
```

Dies ist der einzige Zustand, in dem ein späterer Env-Executor einen atomaren Replace beginnen darf.

### `READY_TO_VALIDATE`

Bedingungen:

- PENDING-Evidence ist vorhanden und verifiziert,
- `.env` entspricht exakt `targetEnvFingerprint`.

Dann gilt:

```text
activationMutationAllowed=false
postWriteValidationRequired=true
```

Dieser Zustand deckt das Crash-Fenster ab, in dem ein zukünftiger atomarer Replace bereits erfolgreich war, der Prozess aber vor der Post-Validation abgebrochen ist. Ein Retry darf die `.env` dann nicht erneut blind schreiben.

### `TARGET_STATE_WITHOUT_EXECUTION_EVIDENCE`

Wenn die `.env` bereits dem Target-Fingerprint entspricht, aber noch keine PENDING-Evidence existiert, wird die Execution nicht nachträglich autorisiert. Das System blockiert fail-closed.

### `ENV_FINGERPRINT_DRIFT`

Jeder dritte Fingerprint blockiert. Insbesondere wird ein geänderter Nicht-Privacy-Wert nicht als legitimer Activation-Zustand interpretiert.

## CLI

PENDING-Evidence vorbereiten oder idempotent wiederverwenden:

```bash
python3 infra/backup/backup-privacy-activation-execution.py prepare \
  --plan-checker /absolute/path/check-backup-privacy-activation-plan.py \
  --plan /absolute/path/activation-....json \
  --key-file /absolute/path/backup-privacy.key \
  --env-file /absolute/path/.env \
  --output-root /var/lib/master-diagnostics/backup-privacy-activation
```

Read-only Zustand bewerten:

```bash
python3 infra/backup/backup-privacy-activation-execution.py check \
  --plan-checker /absolute/path/check-backup-privacy-activation-plan.py \
  --plan /absolute/path/activation-....json \
  --key-file /absolute/path/backup-privacy.key \
  --env-file /absolute/path/.env \
  --execution /var/lib/master-diagnostics/backup-privacy-activation/<activationId>/activation-execution-pending.json
```

## Sicherheitsgrenzen

Die Evidence-Schicht:

- ruft den bestehenden Plan-v2-Checker auf,
- akzeptiert nur genau den im Plan gebundenen `.env`-Pfad,
- lehnt Symlinks und unsichere Dateirechte ab,
- kopiert keine übrigen `.env`-Secrets in Execution Evidence,
- schreibt ausschließlich ihr eigenes Evidence-Verzeichnis,
- verwendet kein `os.replace`, Docker oder Docker Compose,
- setzt `activationExecuted` niemals auf `true`.

## CI

Der Contract prüft serverseitig:

- vollständige Attestation -> Plan-v2 -> Execution-Evidence-Kette,
- dass die Evidence vor jeder `.env`-Mutation existiert,
- deterministischen Retry,
- `READY_TO_APPLY`,
- simuliertes Crash-Fenster nach einem zukünftigen Replace -> `READY_TO_VALIDATE`,
- Blockade eines Target-Zustands ohne PENDING-Evidence,
- Blockade von Nicht-Privacy-Drift,
- HMAC-/Fingerprint-Tampering,
- `0700`/`0600`-Rechte,
- weiterhin keine `.env`-/Docker-Mutation durch diese Schicht.

## Nächster Slice

Der nächste sichere Slice implementiert den atomaren `.env`-Executor auf Basis dieser Evidence:

1. ausschließlich aus `READY_TO_APPLY`,
2. Zielbytes aus Plan v2 deterministisch rekonstruieren,
3. vor Replace erneut Pre-Fingerprint prüfen,
4. atomar ersetzen und fsyncen,
5. bei Retry `READY_TO_VALIDATE` erkennen statt erneut zu schreiben,
6. Post-Write-Runtime-Attestation ausführen,
7. bei Validierungsfehler den Byte-genauen Rollback-Descriptor anwenden,
8. erst danach signierte terminale Execution-Evidence schreiben.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt in der realen Installation bis zu diesem späteren kontrollierten Executor unverändert.
