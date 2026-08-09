# Backup Privacy Service Cutover Plan v1

## Zweck

Nach #226 kann die signierte Activation-ID ihre plan-gebundene Club-`.env` atomar auf den Backup-Privacy-Target-State umstellen und diese **Konfigurationsstufe** HMAC-signiert abschließen. Die bereits laufenden Club-Container können zu diesem Zeitpunkt trotzdem noch mit ihrer vorherigen Prozessumgebung laufen.

Dieser Slice definiert deshalb ausschließlich den nächsten **read-only Service-Cutover-Plan**. Er führt keine Service-Mutation aus.

Die Trust Chain lautet:

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> signed env-activation COMPLETED evidence
  -> verified target Compose render
  -> signed service cutover plan v1
  -> [nächster Slice: signed Live-Baseline]
  -> [erst danach: bounded service cutover]
```

`PRIVACY_BACKUP_STATE=DISABLED` bleibt in der realen Release-Konfiguration unverändert, bis der gesamte operative Pfad einschließlich Live-Cutover und Drill nachgewiesen ist.

## Unabhängige Completion-Verifikation

`check-backup-privacy-activation-completion.py` verifiziert read-only:

- Activation Plan v2 über den bestehenden Plan-Checker,
- PENDING-Evidence über den #225-Checker,
- aktuellen `.env`-Fingerprint als signierten Target-State,
- kanonischen Pfad des `activation-execution-completed.json`,
- dessen Bindung an Activation-ID, Execution-ID, Plan, PENDING-Datei und Pre-/Target-Fingerprints,
- Marker-Fingerprint und HMAC unter der #226-Domain,
- gebundenen SHA-256 der Konfigurations-Policy-Attestation,
- Abwesenheit widersprüchlicher Rollback-Evidence.

Erst dann wird `serviceCutoverPlanningAllowed=true` ausgegeben. Das bedeutet ausschließlich, dass der nächste statische Plan erstellt werden darf.

## Service-Cutover-Plan

`prepare-backup-privacy-service-cutover-plan.py` rendert den Club-Compose-Stack mit der bereits signiert aktivierten Target-`.env` über:

```text
docker compose --env-file <env> -f <club-compose> config --format json
```

Dieser Docker-Aufruf ist read-only; es gibt in diesem Slice kein `up`, `run`, `restart`, `stop`, `down`, keine Volume-Mutation und keinen `os.replace`.

Der Plan bindet unter anderem:

- Activation-ID und Execution-ID,
- vollständige SHA-256 der Activation-Plan-, PENDING- und Completion-Artefakte,
- Completion-Fingerprint und Konfigurations-Attestation-SHA,
- `.env`-Pfad und Target-Fingerprint,
- Compose-Dateipfad und vollständigen Datei-SHA,
- kanonischen SHA-256 des gerenderten Compose-Modells,
- `privacy-check` als obligatorischen Preflight,
- `app`, `export-cleanup` und `retention-scan` als später kontrolliert zu recreatende Services,
- `libsql` und `caddy` als zu erhaltende Services,
- erfolgreiche App-Healthchecks und laufende Background-Services als spätere Pflicht,
- Live-Runtime-Attestation als spätere Pflicht,
- Rollback bei jedem Cutover-Fehler als spätere Pflicht.

Das Artefakt ist HMAC-signiert, deterministisch wiederverwendbar und bleibt ausdrücklich:

```text
serviceCutoverExecuted=false
liveRuntimeAttested=false
```

## Warum der Plan noch keine Service-Mutation autorisiert

Das gerenderte Compose-Modell beschreibt den **Sollzustand nach dem Cutover**. Für Crash-/Retry-Sicherheit reicht das allein nicht aus.

Unmittelbar vor der ersten Service-Mutation muss zusätzlich eine separate signierte **Live-Baseline** persistiert werden. Sie muss mindestens den tatsächlichen Istzustand binden:

- eindeutige aktuelle Container-Identität von `app`, `export-cleanup` und `retention-scan`,
- deren tatsächlich laufende Backup-Privacy-Prozessumgebung als `DISABLED`,
- aktuelle LibSQL-Container-/Image-Identität,
- aktuelle Caddy-Container-/Image-Identität,
- tatsächliche Named-Volume-Mounts für LibSQL, Reports, Tenant Exports und Data-Subject Delivery,
- Health-/Running-State der relevanten Container,
- den exakten Cutover-Plan-Fingerprint.

Diese Live-Baseline muss außerhalb der zu recreatenden Container dauerhaft und signiert liegen. Erst sie ermöglicht nach einem Crash mitten im Recreate eine eindeutige Entscheidung, welche Rollen bereits den Target-Live-State erreicht haben und welche noch der Rollback-Baseline entsprechen.

**Ohne diese Live-Baseline darf keine Service-Mutation stattfinden.**

## Vorgesehener späterer Cutover

Der spätere Executor soll auf Plan + Live-Baseline eng begrenzt sein:

1. Target-Compose und Plan erneut verifizieren.
2. `privacy-check` gegen den Target-State erfolgreich ausführen.
3. Durable `CUTOVER_STARTED`-Evidence schreiben.
4. Nur die plan-gebundenen Runtime-Services kontrolliert recreaten.
5. LibSQL und Caddy nicht recreaten; ihre Baseline-Identität muss erhalten bleiben.
6. Named Data Volumes nach jedem Recreate gegen die Baseline prüfen.
7. App muss healthy sein; Background-Services müssen running sein.
8. Die tatsächliche Prozessumgebung des neuen App-Containers muss `PRIVACY_BACKUP_STATE=ENABLED` plus Policy v1 tragen.
9. Erst dann darf eine separate Live-Cutover-Completion-Evidence entstehen.

Schlägt einer dieser Schritte fehl, muss **vor** jeder Rückmutation durable Rollback-Evidence geschrieben werden. Danach wird die `.env` bytegenau über den signierten Activation-Plan-v2-Rollback zurückgeführt, die betroffenen Services werden kontrolliert auf DISABLED recreated und die Live-Baseline-/Volume-Invarianten werden erneut geprüft.

## CI-Contract

Der `Backup Privacy Service Cutover Plan Contract` prüft:

- die vollständige signierte #220 -> #226 Testkette,
- unabhängige Completion-Verifikation,
- Target-Compose-Rendering und Pflichtservices,
- deterministische Plan-Wiederverwendung,
- Completion-Tamper-Blockade,
- Compose-Dateidrift auch bei semantisch neutraler Kommentaränderung,
- Plan-Fingerprint-/HMAC-Tamper-Blockade,
- `0600` für Planartefakte,
- die vollständige Abwesenheit mutierender Docker-/Filesystem-Operationen in diesem Slice.

## Nächster Slice

Der nächste sichere Slice ist die **signierte Live-Baseline**. Erst danach darf ein mutierender Service-Cutover-Executor implementiert werden.
