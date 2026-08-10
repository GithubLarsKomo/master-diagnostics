# Backup Privacy Service Cutover Execution v2

## Zweck

Dieser Slice definiert die signierte, crash-sichere Evidence-State-Machine zwischen einer **unabhängig verifizierten Service Live Baseline v2** und dem späteren mutierenden Host-Executor.

Er führt selbst **keine Docker-, Compose- oder `.env`-Mutation** aus. Seine Aufgabe ist ausschließlich, zu jedem Zeitpunkt eindeutig festzulegen:

- ob eine Mutation überhaupt begonnen werden darf,
- in welche Richtung ein Retry weiterlaufen darf,
- ob eine bereits erfolgte Mutation nur noch durch Evidence nachgezogen werden muss,
- wann Rollback sticky geworden ist,
- und wann terminales `activationExecuted=true` überhaupt zulässig ist.

## Eingangskette

```text
TARGET_HANDOFF_VERIFIED
  -> gated Service Cutover Plan v2
     serviceCutoverExecutionAllowed=false
  -> signed Service Live Baseline v2
  -> SERVICE_LIVE_BASELINE_VERIFIED
     serviceCutoverExecutionAllowed=true
  -> signed Execution Journal v2
  -> CUTOVER_STARTED
  -> [späterer Host-Mutator]
```

Das Execution-Journal darf nur erzeugt werden, wenn gleichzeitig:

1. der HMAC-signierte Cutover-Plan v2 gültig und `TARGET_HANDOFF_VERIFIED`-gebunden ist,
2. die HMAC-signierte Baseline v2 gültig ist,
3. eine private Ausgabe des unabhängigen Baseline-Checkers `SERVICE_LIVE_BASELINE_VERIFIED` bestätigt,
4. deren Baseline-, Cutover- und Handoff-Fingerprints exakt passen,
5. der übergebene aktuelle Inspect-Istzustand noch exakt dem signierten Pre-Mutation-State entspricht.

Der SHA-256 der privaten Verifier-Ausgabe wird in das signierte Journal aufgenommen. Damit ist dokumentiert, welche unabhängige Live-Re-Attestation das Journal autorisiert hat.

## Evidence-only Grenze

`infra/backup/backup-privacy-service-cutover-execution.py` verwendet keine Docker-/Compose-Kommandos und keinen `subprocess`-Aufruf. Der aktuelle Zustand wird als vom späteren Host-Wrapper gesammelte, read-only `docker inspect`-Evidence übergeben.

Der Slice verändert auch die Target-`.env` nicht. Damit kann seine gesamte Zustandslogik separat von den späteren mutierenden Host-Kommandos getestet und auditiert werden.

## Gebundene Invarianten

Die State-Machine bindet den Cutover-Plan und die Baseline v2 erneut. Für den aktuellen Live-State gelten dauerhaft:

- `libsql` und `caddy` behalten Container-ID, Image-ID und Image-Referenz,
- `libsql` bleibt healthy,
- alle fünf Services bleiben running,
- `app` bleibt healthy,
- die drei mutable Services verwenden weiterhin das signierte Image,
- LibSQL-, Reports-, Tenant-Export- und Data-Subject-Delivery-Volumes bleiben identisch,
- `export-cleanup` verwendet dieselben Export-/Delivery-Volumes wie `app`,
- Caddy Data und Caddy Config bleiben auf den signierten Named Volumes,
- unbekannte oder inkonsistente Privacy-Runtime-Zustände blockieren fail-closed.

## Live-State-Klassifikation

Die drei mutable Services werden anhand ihrer tatsächlichen Backup-Privacy-Prozessumgebung klassifiziert:

- `BASELINE`: alle drei `DISABLED` und noch die signierten Pre-Mutation-Container-IDs,
- `TARGET`: alle drei vollständig auf dem Target-v1-Environment `ENABLED`,
- `MIXED_KNOWN`: teilweise bekannte Target-/DISABLED-Recreates,
- `ROLLBACK`: alle drei wieder `DISABLED`, aber mit neuen Container-IDs,
- `UNKNOWN`: jede nicht beweisbare Kombination oder jede Preserve-/Volume-/Health-Abweichung.

`UNKNOWN` autorisiert niemals eine Mutation.

## Journal v2

Vor dem ersten `CUTOVER_STARTED` wird ein privates (`0600`) HMAC-signiertes Journal unter einem privaten Execution-Verzeichnis (`0700`) persistiert.

Signing Domain:

```text
masters:backup-privacy-service-cutover-execution-journal:v2
```

Das Journal bindet unter anderem:

- Activation-/Cutover-/Baseline-ID,
- Cutover-Plan-Fingerprint und Datei-SHA,
- Baseline-Fingerprint, Datei-SHA und HMAC,
- Pfad und SHA der unabhängigen Baseline-Verifier-Ausgabe,
- `liveStateFingerprint` des Pre-States,
- Target-Handoff-Fingerprint,
- exakte Recreate-/Preserve-Service-Mengen,
- Target-Privacy-Environment,
- `baselineVerifiedBeforeJournal=true`,
- `journalRequiredBeforeMutation=true`,
- `rollbackStartedRequiredBeforeReverseMutation=true`,
- `preservedIdentityRequiredThroughout=true`,
- `dataVolumesMustRemainBound=true`.

Vor einem Event bleibt:

```text
serviceMutationStarted=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Append-only Event-Kette

Jedes Event ist HMAC-signiert und bindet die Signatur des Vorgängers.

Signing Domain:

```text
masters:backup-privacy-service-cutover-execution-event:v2
```

Zulässiger Erfolgsweg:

```text
CUTOVER_STARTED
  -> TARGET_RECREATED
  -> LIVE_VALIDATED
  -> COMPLETED
```

Zulässiger Rollback-Weg:

```text
CUTOVER_STARTED
  -> [optional TARGET_RECREATED]
  -> ROLLBACK_STARTED
  -> ROLLBACK_RECREATED
  -> ROLLBACK_VERIFIED
```

Nach `ROLLBACK_STARTED` gibt es keinen Übergang mehr zurück in den Target-Erfolgsweg.

## Crash-/Retry-Semantik

Die State-Machine unterscheidet Evidence-Fortschritt und bereits sichtbaren Live-State.

Beispiele:

- `CUTOVER_STARTED` + teilweise Target-Recreates -> `READY_TO_RECREATE_TARGET`.
- `CUTOVER_STARTED` + bereits vollständiger Target-State -> `RECOVER_TARGET_RECREATED`: nur das fehlende Event nachziehen, **nicht nochmals recreaten**.
- `ROLLBACK_STARTED` + teilweise Target-/Rollback-Lage -> ausschließlich `READY_TO_RECREATE_ROLLBACK`.
- `ROLLBACK_STARTED` + bereits vollständig zurückgerollter DISABLED-State -> `RECOVER_ROLLBACK_RECREATED`: nur Evidence nachziehen.

Damit ist ein Crash zwischen realer Mutation und Evidence-Persistenz explizit modelliert.

## Live-Attestation und Terminalität

`LIVE_VALIDATED` erfordert ein privates Attestation-Artefakt mit:

```json
{"status":"VERIFIED","backupState":"ENABLED"}
```

`ROLLBACK_VERIFIED` erfordert entsprechend:

```json
{"status":"VERIFIED","backupState":"DISABLED"}
```

Der SHA-256 des Attestation-Artefakts wird im signierten Event gebunden.

Nur nach

```text
TARGET_RECREATED
  -> LIVE_VALIDATED
  -> weiterhin TARGET-Live-State
  -> COMPLETED
```

werden gleichzeitig gesetzt:

```text
serviceCutoverExecuted=true
liveRuntimeAttested=true
activationExecuted=true
```

`ROLLBACK_VERIFIED` bleibt dagegen terminal sicher mit:

```text
serviceCutoverExecuted=false
activationExecuted=false
```

## Noch keine reale Aktivierung

Dieser Slice beweist nur die State-Machine. Seine CI verwendet synthetische Inspect-Snapshots, die aus der real signierten Baseline-v2-Test-Evidence abgeleitet werden.

Er ist **kein Nachweis**, dass ein echter Host bereits Services recreated oder einen Restore-/RTO-Drill bestanden hat. `.env.example` bleibt daher `PRIVACY_BACKUP_STATE=DISABLED`, und die praktischen Release-Gates bleiben offen.

## Nächster Slice

Erst nach erfolgreichem Merge dieser Evidence-State-Machine darf der bounded Host-Executor entstehen. Dieser muss:

1. unmittelbar vor Mutation die v2-Baseline erneut live verifizieren,
2. das signierte Journal verifizieren,
3. `CUTOVER_STARTED` durable persistieren,
4. den Target-Preflight ausführen,
5. nur `app`, `export-cleanup`, `retention-scan` recreaten,
6. nach jedem Schritt Preserve- und Volume-Invarianten prüfen,
7. den tatsächlichen neuen Prozesszustand attestieren,
8. die State-Machine anhand der realen Inspect-Evidence fortschreiben,
9. bei jedem Fehler vor Reverse-Mutation `ROLLBACK_STARTED` durable persistieren,
10. erst nach `LIVE_VALIDATED` terminal `COMPLETED` erzeugen.

Bis dahin findet keine produktive Docker-Mutation statt.