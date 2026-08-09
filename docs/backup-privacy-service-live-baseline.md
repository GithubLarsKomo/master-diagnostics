# Backup Privacy Service Live Baseline v1

## Zweck

Der Service-Cutover-Plan v2 beschreibt den gewünschten Target-Zustand, erlaubt aber bewusst noch keine Container-Mutation. Unmittelbar vor dem ersten Recreate muss zusätzlich der **tatsächlich laufende DISABLED-Zustand** kryptografisch gebunden werden.

Die Live-Baseline ist deshalb die letzte read-only Evidence-Schicht vor dem späteren Host-Cutover:

```text
TARGET_HANDOFF_VERIFIED
  -> Service-Cutover-Plan v2
  -> LIVE_BASELINE_VERIFIED
  -> [next: bounded service cutover]
```

Erst nach erfolgreicher Baseline gilt:

```text
serviceCutoverExecutionAllowed=true
```

Weiterhin gilt:

```text
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Was die Baseline bindet

Die Baseline verifiziert den Cutover-Plan v2 unmittelbar erneut und bindet anschließend technische Live-Evidence für genau fünf Services:

### Recreate-Services

- `app`
- `export-cleanup`
- `retention-scan`

Für diese Services muss die reale `docker inspect`-Environment weiterhin explizit enthalten:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

Damit ist nachgewiesen, dass die Host-`.env` zwar bereits den Target-State enthält, die aktuell laufenden Prozesse aber noch die ursprüngliche DISABLED-Runtime verwenden.

Die vollständige Container-Environment wird **nicht** persistiert. Gespeichert werden nur:

- `privacyBackupState=DISABLED`,
- ein SHA-256-Fingerprint der begrenzten `PRIVACY_*`-Teilmenge.

Secrets wie `BETTER_AUTH_SECRET` gelangen nicht in die Baseline.

### Preserve-Services

- `libsql`
- `caddy`

Für beide werden exakte Container- und Image-Identitäten gebunden. Der spätere Cutover muss diese Identitäten unverändert erhalten.

## Health- und Running-Gates

Vor Baseline-Erstellung müssen alle fünf Services eindeutig und `running` sein.

Zusätzlich:

- `app` muss `healthy` sein,
- `libsql` muss `healthy` sein,
- `export-cleanup`, `retention-scan` und `caddy` müssen mindestens `running` sein.

Fehlende oder mehrdeutige Container-Evidence blockiert.

## Volume-Bindung

Die Baseline bindet die aktuell aktiven Named Volumes:

- LibSQL: `/var/lib/sqld`
- Reports: `/var/lib/masters/reports`
- Tenant Exports: `/var/lib/masters/exports`
- Data-Subject Delivery: `/var/lib/masters/data-subject-delivery-packages`
- Caddy Data: `/data`
- Caddy Config: `/config`

Zusätzliche Konsistenzregeln:

- die vier Anwendungs-Datenrollen müssen unterschiedliche Volumes verwenden,
- `export-cleanup` muss exakt dieselben Export-/Delivery-Volumes wie `app` verwenden,
- Caddy Data und Config müssen unterschiedliche Named Volumes sein.

Damit kann ein späterer Cutover sowohl Preserve-Identität als auch Datenpfad-Kontinuität gegen die signierte Baseline prüfen.

## Compose-Identität

Die `docker inspect`-Evidence wird gegen den aktuell erneut gerenderten Compose-Projektnamen geprüft:

- `com.docker.compose.project`
- `com.docker.compose.service`

Ein Container aus einem anderen Projekt oder mit falscher Service-Identität wird nicht akzeptiert.

## Signatur und Persistenz

Signing Domain:

```text
masters:backup-privacy-service-live-baseline:v1
```

Persistenz:

```text
<baseline-root>/<cutoverId>/service-live-baseline.json
```

Rechte:

- Root: `0700`
- Cutover-Verzeichnis: `0700`
- Baseline: `0600`

Die Baseline bindet außerdem:

- Cutover-ID,
- Activation-/Execution-ID,
- Cutover-Plan-Fingerprint und vollständigen Datei-SHA,
- Target-Handoff-Fingerprint,
- Target-Env-Fingerprint,
- gerenderten Compose-SHA,
- Container-/Image-Identitäten,
- relevante Volume-Namen,
- eigenen Baseline-Fingerprint.

Ein Retry verwendet die vorhandene signierte Evidence nur weiter, wenn die aktuelle Live-Lage weiterhin exakt passt. Die ursprüngliche `recordedAt`-Zeit wird nicht durch Retry neu geschrieben.

## Drift nach Baseline

`check` liest die aktuelle Inspect-Evidence erneut. Folgende Änderungen blockieren vor jeder Service-Mutation:

- ein Recreate-Service ist nicht mehr `DISABLED`,
- Container-ID oder Image-ID ändert sich,
- `libsql` oder `caddy` wurde ersetzt,
- App/LibSQL verlieren `healthy`,
- ein Service ist nicht mehr `running`,
- Datenvolume oder Caddy-Volume ändert sich,
- Export-Cleanup und App verwenden unterschiedliche Export-/Delivery-Volumes,
- Compose-Projekt-/Service-Labels passen nicht mehr,
- Baseline-Fingerprint oder HMAC wurde manipuliert.

## Keine Service-Mutation

Diese Schicht ist strikt read-only gegenüber Docker.

Sie darf:

- den Cutover-Plan v2 erneut verifizieren,
- `docker compose config --format json` rendern,
- bereits vom Host gesammelte `docker inspect`-JSON-Evidence lesen,
- signierte Baseline-Evidence schreiben.

Sie darf **keine Service-Mutation** ausführen. Insbesondere kein:

- `docker inspect` direkt aus dem Python-Core,
- `docker compose up/restart/stop/down`,
- `docker rm`,
- `docker volume`-Mutation,
- `.env`-Replace.

Der spätere Host-Wrapper darf ausschließlich read-only `docker compose ps -a` und `docker inspect` verwenden, um die Eingabe-Evidence für diesen Core zu sammeln.

## Nächster Slice

Nach `LIVE_BASELINE_VERIFIED` kann erstmals ein bounded Host-Cutover implementiert werden.

Der Executor muss mindestens:

1. die Baseline unmittelbar vor Mutation erneut verifizieren,
2. durable `CUTOVER_STARTED`-Evidence persistieren,
3. ausschließlich `app`, `export-cleanup`, `retention-scan` mit dem Target-Env neu erzeugen,
4. `libsql` und `caddy` anhand der Baseline-IDs unverändert lassen,
5. App-Health und Background-Running-State prüfen,
6. die **laufenden** Recreate-Container auf `PRIVACY_BACKUP_STATE=ENABLED` attestieren,
7. erst dann echte terminale Completion / `activationExecuted=true` schreiben.

Bei Fehlern muss vor Rollback-Mutation durable Rollback-Evidence existieren; anschließend `.env` bytegenau zurück, die drei Recreate-Services auf DISABLED neu erzeugen und der laufende DISABLED-State verifizieren.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt bis zu diesem kontrollierten Live-Cutover und dem praktischen Drill die Release-Grenze.
