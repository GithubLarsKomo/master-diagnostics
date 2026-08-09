# Backup Privacy Activation Executor v1

## Zweck

Dieser Slice führt erstmals eine **gebundene Runtime-Konfigurationsmutation** für die Backup-Privacy-Attestation ein. Er baut ausschließlich auf dem signierten Activation Plan v2 und der #225-PENDING-Execution-Evidence auf.

Der Executor ist absichtlich noch **kein Deployment-Restarter**. Er ändert atomar nur die im Plan gebundene `.env`, validiert anschließend die echte globale Privacy-Policy über `@masters/db privacy-capabilities:check` und rollt die `.env` bei fehlgeschlagener ENABLED-Validation bytegenau auf den signierten Ausgangszustand zurück.

In CI wird der Executor ausschließlich gegen temporäre `.env`-Dateien ausgeführt. Ein grüner PR aktiviert keine reale Installation.

## Autorisierungskette

Vor jedem Lauf müssen bereits vorhanden und gültig sein:

```text
signed RTO drill
  -> signed manual backup-privacy attestation
  -> signed reversible activation plan v2
  -> signed PENDING activation execution evidence (#225)
```

Der Executor ruft den #225-Checker erneut auf und akzeptiert nur:

- `READY_TO_APPLY`, oder
- bei einem Retry nach bereits erfolgtem Target-Replace `READY_TO_VALIDATE`.

Ein Target-Zustand ohne eigene `MUTATION_STARTED`-Receipt wird nicht nachträglich übernommen.

## Runtime-Policy-Checker

`infra/backup/check-backup-privacy-runtime-env.py` liest ausschließlich die bekannten globalen Privacy-Variablen aus der gebundenen `.env` und führt danach den bestehenden produktiven Policy-Check aus:

```bash
pnpm --silent --filter @masters/db privacy-capabilities:check
```

Dabei werden bereits im Prozess vorhandene `PRIVACY_*`-Werte für diese Capability-Schlüssel entfernt und durch die Werte aus der gebundenen `.env` ersetzt.

Für den Target-Zustand muss gelten:

```text
readyForIrreversibleProcessing=true
backupState=ENABLED
backupPolicyVersion=1.0.0
blockers=[]
```

Für den Rollback-Zustand wird dieselbe Policy mit `backupState=DISABLED` erneut verifiziert.

## Signierte Executor-Receipts

Die Executor-Receipts verwenden die eigene HMAC-Domain:

```text
masters:backup-privacy-activation-executor-receipt:v1
```

Sie liegen im bereits privaten activation-spezifischen #225-Evidence-Verzeichnis und sind `0600`.

### `MUTATION_STARTED`

Datei:

```text
activation-mutation-started.json
```

Sie wird **vor dem ersten atomaren Replace** geschrieben und bindet zusätzlich die erfolgreiche DISABLED-Runtime-Attestation.

### `COMPLETED`

Datei:

```text
activation-completed.json
```

Sie darf nur nach erfolgreicher ENABLED-Runtime-Attestation entstehen und bindet deren Fingerprint.

### `ROLLBACK_STARTED`

Datei:

```text
activation-rollback-started.json
```

Sie wird vor dem ersten Reverse-Replace geschrieben und bindet einen SHA-256 der fehlgeschlagenen Target-Validation-Evidence. Sobald sie existiert, ist die Richtung auf Rollback festgelegt.

### `ROLLED_BACK`

Datei:

```text
activation-rolled-back.json
```

Sie entsteht erst, wenn die `.env` wieder exakt `currentEnvFingerprint` entspricht und die DISABLED-Runtime-Policy erfolgreich verifiziert wurde.

Die Receipts bilden eine Signaturkette:

```text
MUTATION_STARTED -> COMPLETED
```

oder

```text
MUTATION_STARTED -> ROLLBACK_STARTED -> ROLLED_BACK
```

Beide terminalen Richtungen gleichzeitig sind verboten.

## Atomarer Target-Replace

Der Target-Bytestring wird nicht aus freien Eingaben erzeugt. Der Executor rekonstruiert ihn ausschließlich aus:

- dem aktuell exakt passenden `currentEnvFingerprint`,
- `activationTarget`,
- dem signierten `rollbackDescriptor` aus Plan v2.

Vor `os.replace(...)` wird der Pre-Fingerprint unmittelbar erneut geprüft. Die temporäre Datei liegt im selben Verzeichnis, wird vollständig geschrieben und `fsync`-t; Dateimodus und – soweit der Executor dazu berechtigt ist – Eigentümer werden erhalten. Nach `os.replace(...)` wird auch das Parent-Verzeichnis `fsync`-t und der resultierende Bytestring erneut gegen `targetEnvFingerprint` geprüft.

Andere `.env`-Zeilen werden nicht semantisch neu serialisiert. Der signierte Target-Fingerprint ist die abschließende Byte-Grenze.

## Bytegenauer Rollback

Bei fehlgeschlagener ENABLED-Runtime-Validation wird zuerst `ROLLBACK_STARTED` persistiert. Danach wird ausschließlich der Plan-v2-`rollbackDescriptor` rückwärts angewendet.

Der rekonstruierte Bytestring muss exakt `currentEnvFingerprint` ergeben, bevor er atomar zurückgeschrieben werden darf.

Nach dem Reverse-Replace muss die globale Privacy-Policy erneut im DISABLED-Zustand grün sein. Erst dann entsteht `ROLLED_BACK`.

## Crash-/Retry-Verhalten

### Crash nach `MUTATION_STARTED`, vor Target-Replace

Die `.env` liegt noch im Pre-Fingerprint. Ein Retry darf den exakt gebundenen Target-Replace erneut versuchen.

### Crash nach Target-Replace, vor Validation/Completion

Die #225-Evidence meldet `READY_TO_VALIDATE`. Da `MUTATION_STARTED` bereits existiert, wird **nicht erneut geschrieben**. Der Executor fährt mit Runtime-Validation fort.

### Crash nach erfolgreicher Validation, vor `COMPLETED`

Die Runtime-Validation darf idempotent wiederholt werden; danach wird die terminale Receipt geschrieben.

### Crash nach `ROLLBACK_STARTED`, vor Reverse-Replace

Die `.env` liegt noch im Target-Fingerprint. Der Retry rekonstruiert den signierten Ausgangszustand und führt den Reverse-Replace aus.

### Crash nach Reverse-Replace, vor `ROLLED_BACK`

Die `.env` liegt bereits exakt im Pre-Fingerprint. Es wird **nicht erneut geschrieben**. Nur DISABLED-Runtime-Validation und terminale Receipt werden nachgezogen.

### Drift

Jeder Bytestring außerhalb der zwei signierten Plan-Fingerprints blockiert. Ebenso blockieren ungültige HMAC-Receipts, widersprüchliche Terminalrichtungen oder eine Env-/Plan-/PENDING-Bindungsabweichung.

## Bewusste Betriebsgrenze

Dieser Executor:

- verändert keine Docker-Volumes,
- startet oder stoppt keine Container,
- führt kein `docker compose up/down/restart` aus,
- ändert keine Backup-Retention,
- markiert den praktischen Restore-/RTO-Release-Gate noch nicht als abgeschlossen.

Nach erfolgreichem `COMPLETED` ist die **Dateikonfiguration** auf ENABLED attestiert. Bereits laufende App-/Worker-Prozesse können weiterhin mit dem alten Environment laufen, bis eine nachgelagerte, kontrollierte Deployment-Recreate-Schicht die neue `.env` übernimmt.

Deshalb bleibt `.env.example` weiterhin bei:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

und ein CI-Lauf führt keine reale Aktivierung durch.

## CI-Vertrag

Der spezialisierte Contract beweist serverseitig:

- reale Policy-Evaluation für DISABLED und ENABLED,
- atomaren Target-Replace auf einer temporären `.env`,
- Erhalt eines nicht zielbezogenen Secrets,
- `0600`-Dateirechte,
- idempotenten terminalen Erfolg,
- Recovery nach Crash direkt nach Target-Replace ohne zweiten Write,
- automatische bytegenaue Rückkehr nach simuliertem ENABLED-Validation-Fehler,
- Recovery nach Crash nach Reverse-Replace ohne zweiten Rollback-Write,
- Env-Drift-Blockade,
- HMAC-Tamper-Blockade terminaler Receipts,
- weiterhin unveränderte Release-/RTO-Gates.

## Nächster Slice

Der nächste sichere Slice ist die **Deployment Activation/Recreate-Schicht**. Sie darf nur ein verifiziertes `COMPLETED` dieses Executors konsumieren, muss die betroffenen Club-Services mit der neuen `.env` kontrolliert neu erzeugen, danach die tatsächlich laufenden Container erneut attestieren und bei fehlgeschlagenem Runtime-Recreate auf die signierte Pre-Konfiguration plus passenden Service-Recreate zurückrollen.
