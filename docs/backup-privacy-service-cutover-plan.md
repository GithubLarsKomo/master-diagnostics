# Backup Privacy Service Cutover Plan v2

## Zweck

Nach dem atomaren Target-`.env`-Write beweist `TARGET_HANDOFF_VERIFIED` aus #231 ausschließlich zwei Dinge:

1. die plan-gebundene `.env` entspricht exakt dem signierten Target-Fingerprint,
2. diese Target-Konfiguration erfüllt die Backup-Privacy-Policy.

Es beweist ausdrücklich **nicht**, dass die bereits laufenden Club-Prozesse diese Konfiguration übernommen haben. Deshalb bleibt `activationExecuted=false`.

Der Service-Cutover-Plan v2 beschreibt nur den nächsten Sollzustand und bindet ihn kryptografisch an diese nichtterminale Handoff-Evidence. Er führt keine Service-Mutation aus.

## Korrigierte Trust Chain

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> atomic target .env replace
  -> signed TARGET_HANDOFF_READY
  -> TARGET_HANDOFF_VERIFIED
  -> verified target Compose render
  -> signed service cutover plan v2
  -> [nächster Slice: signed Live-Baseline]
  -> [danach: bounded service recreate]
  -> [danach: live-process attestation]
  -> [erst dann: terminal activation completion]
```

Die alte v1-Bindung an ein vor dem Service-Cutover erzeugtes `activation-execution-completed.json` wird nicht mehr akzeptiert.

## Handoff-Verifikation

Sowohl Writer als auch Checker führen `check-backup-privacy-target-handoff.py` erneut aus. Verlangt werden:

```text
status=TARGET_HANDOFF_VERIFIED
serviceCutoverPlanningAllowed=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Damit werden vor jeder Plan-Erstellung beziehungsweise Plan-Verifikation erneut geprüft:

- Activation Plan v2,
- PENDING-Evidence,
- aktueller Target-`.env`-Fingerprint,
- Handoff-HMAC und Handoff-Fingerprint,
- Target-Checker-Dateihash,
- aktuelle Target-Konfigurations-Attestation,
- Abwesenheit von Rollback- und Legacy-Completion-Konflikten.

## Signierte v2-Bindung

Die HMAC-Domain wurde bewusst geändert auf:

```text
masters:backup-privacy-service-cutover-plan:v2
```

Der Plan bindet:

- Activation-ID und Execution-ID,
- vollständigen SHA-256 des Activation Plans,
- vollständigen SHA-256 der PENDING-Evidence,
- absoluten Pfad der Target-Handoff-Evidence,
- `targetHandoffFingerprint`,
- vollständigen SHA-256 der Handoff-Datei,
- SHA-256 der Target-Konfigurations-Attestation,
- Activation-Plan-Fingerprint,
- `.env`-Pfad und Target-Fingerprint,
- Compose-Dateipfad und vollständigen Datei-SHA,
- kanonischen SHA-256 des gerenderten Compose-Modells.

Felder der alten vorzeitigen Completion – insbesondere `completionPath`, `completionFingerprint` und `configurationRuntimeAttestationSha256` – gehören nicht mehr zum v2-Plan.

## Read-only Compose-Validierung

Der Target-Stack wird ausschließlich über

```text
docker compose --env-file <env> -f <club-compose> config --format json
```

gerendert. Dieser Aufruf mutiert keinen Docker-Zustand.

Der Render muss weiterhin enthalten:

- `privacy-check` als obligatorischen Preflight,
- `app`, `export-cleanup` und `retention-scan` als später zu recreatende Runtime-Services,
- `libsql` und `caddy` als zu erhaltende Services.

Für `privacy-check` und alle drei später zu recreatenden Services müssen die fünf Backup-Privacy-Targetwerte exakt gerendert sein:

```text
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
```

`privacy-check` muss den kanonischen `privacy-capabilities:check` ausführen. `app` muss von `privacy-check` mit `condition=service_completed_successfully` abhängen.

## Safety-Policy des Plans

Der signierte v2-Plan schreibt fest:

```text
targetHandoffMustRemainVerified=true
preflightMustSucceedBeforeMutation=true
liveBaselineRequiredBeforeMutation=true
renderedComposeMustRemainBound=true
caddyContainerMustBePreserved=true
libsqlContainerMustBePreserved=true
appHealthcheckRequired=true
backgroundServicesRunningRequired=true
liveRuntimeEnvironmentAttestationRequired=true
rollbackOnCutoverFailureRequired=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Besonders wichtig: Ein gültiger Service-Cutover-Plan allein liefert noch **keine Ausführungsfreigabe**. Der Writer und der Checker geben bis zur signierten Live-Baseline bewusst aus:

```text
liveBaselineRequired=true
serviceCutoverExecutionAllowed=false
```

## Warum die Live-Baseline zwingend folgt

Das Compose-Modell beschreibt den Target-Sollzustand, aber nicht den tatsächlichen Istzustand der laufenden Container. Vor der ersten Service-Mutation muss deshalb eine signierte Live-Baseline mindestens binden:

- eindeutige aktuelle Container-Identität von `app`, `export-cleanup`, `retention-scan`, `libsql` und `caddy`,
- Image-Identität, Startzeit und Restart-Zähler,
- den tatsächlich laufenden Backup-Privacy-State der drei Runtime-Services als `DISABLED`,
- Health-/Running-State,
- aktive Named-Volume-Mounts für LibSQL, Reports, Tenant Exports und Data-Subject Delivery,
- Caddy Data/Config Volumes,
- den exakten v2-Cutover-Plan-Fingerprint.

**Ohne diese Live-Baseline darf keine Service-Mutation stattfinden.**

## Vorgesehener späterer Cutover

Der spätere Executor muss mindestens:

1. Target-Handoff, v2-Plan und Live-Baseline unmittelbar vor der Mutation erneut verifizieren.
2. Den Target-`privacy-check` erfolgreich ausführen.
3. Durable `CUTOVER_STARTED`-Evidence schreiben.
4. Nur `app`, `export-cleanup` und `retention-scan` kontrolliert recreaten.
5. `libsql` und `caddy` unverändert erhalten.
6. Named-Volume-Invarianten nach jedem Recreate prüfen.
7. App-Health und Background-Running-State nachweisen.
8. Die **tatsächliche Prozessumgebung** der neuen Runtime-Container als Target-State attestieren.
9. Erst danach terminal `activationExecuted=true` persistieren.

Jeder Fehler muss vor der Rückmutation durable Rollback-Evidence erzeugen. Anschließend muss die `.env` bytegenau über den signierten Plan-v2-Rollback auf `DISABLED` zurückgeführt und der Runtime-Stack kontrolliert in den Baseline-State gebracht werden.

## CI-Contract

Der Contract baut die vollständige signierte Kette bis `TARGET_HANDOFF_READY` auf und prüft:

- v2-Plan-Erstellung ohne Legacy-Completion,
- unabhängige Handoff-Reverifikation,
- Target-Compose-Rendering und Pflichtservices,
- Handoff-/Target-Attestation-Bindung,
- deterministische Plan-Wiederverwendung,
- Handoff-Tamper-Blockade,
- Compose-Dateidrift auch bei semantisch neutraler Kommentaränderung,
- Ablehnung von Planversion 1,
- Plan-Fingerprint-/Policy-Tamper-Blockade,
- `0700`/`0600`-Evidence-Grenzen,
- Abwesenheit von `docker inspect`, `docker ps` und allen mutierenden Docker-/Filesystem-Operationen in diesem Slice.

## Release-Grenze

`.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`. Die praktischen Restore-/RTO- und Release-Gates bleiben offen. Der nächste sichere Slice ist die **signierte Live-Baseline auf Basis dieses v2-Plans**.
