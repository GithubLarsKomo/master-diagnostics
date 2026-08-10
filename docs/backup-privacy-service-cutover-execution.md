# Backup Privacy Service Cutover Execution v1

## Zweck

Die signierte Live-Baseline erlaubt erstmals die spätere Service-Mutation. Zwischen dieser Freigabe und der ersten tatsächlichen Container-Änderung braucht der Cutover jedoch noch ein dauerhaftes Crash-/Retry-Artefakt.

Diese Schicht persistiert deshalb **vor jeder Produktivmutation**:

```text
service-cutover-started.json
```

mit Phase:

```text
CUTOVER_STARTED
```

Erst nach erfolgreicher erneuter Live-Baseline-Verifikation und verifiziertem CUTOVER_STARTED darf ein späterer Host-Executor die erste Container-Mutation ausführen.

## Trust Chain

```text
Service-Cutover-Plan v2
  -> SERVICE_LIVE_BASELINE_VERIFIED
  -> CUTOVER_STARTED
  -> [next: bounded container mutation]
```

`CUTOVER_STARTED` ist ausdrücklich **keine** Aussage, dass bereits ein Container geändert wurde:

```text
productionMutationApplied=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Baseline-Revalidation

`prepare` und `check` rufen den gemergten Live-Baseline-Checker erneut auf. Dadurch müssen unmittelbar vor der nächsten Mutation weiterhin gelten:

- Cutover-Plan v2 aktuell verifiziert,
- Target-Handoff aktuell verifiziert,
- Host-`.env` weiterhin exakt im Target-State,
- Recreate-Services tatsächlich noch `PRIVACY_BACKUP_STATE=DISABLED`,
- App/LibSQL Health gültig,
- Background Services running,
- Preserve-Container-IDs unverändert,
- Daten-/Caddy-Volumes unverändert,
- Live-Baseline-HMAC/Fingerprint gültig.

Wenn diese Live-Lage driftet, bleibt `serviceCutoverMutationAllowed=false`.

## Signatur

Signing Domain:

```text
masters:backup-privacy-service-cutover-execution:v1
```

Das Artefakt bindet:

- Cutover-/Activation-ID,
- deterministische Cutover-Execution-ID,
- Baseline-ID,
- Baseline-Fingerprint,
- Live-Fingerprint,
- vollständigen Baseline-Datei-SHA,
- Cutover-Plan-Fingerprint,
- Target-Handoff-Fingerprint,
- Target-Env-Fingerprint,
- eigenen Execution-Fingerprint.

Safety-Flags:

```text
liveBaselineMustRemainVerifiedBeforeMutation=true
preserveIdentityRequired=true
rollbackRequiredOnCutoverFailure=true
cutoverExecutionStarted=true
productionMutationApplied=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Persistenz und Retry

Persistenz:

```text
<execution-root>/<cutoverId>/service-cutover-started.json
```

Rechte:

- Execution-Root `0700`
- Cutover-Verzeichnis `0700`
- Evidence `0600`

Die Execution-ID ist deterministisch aus der signierten Baseline-Identität abgeleitet. Ein Retry nach einem Crash **vor** der ersten Mutation verwendet das bereits existierende Artefakt wieder; ein neuer `recordedAt`-Wert überschreibt die ursprüngliche Evidence nicht.

Wenn sich Baseline-Datei, Live-Fingerprint oder aktuelle Live-Lage zwischenzeitlich ändern, kann die bestehende CUTOVER_STARTED-Evidence nicht weiterverwendet werden.

## Keine Container-Mutation

Dieser Slice bleibt vollständig evidence-only. Er enthält insbesondere kein:

- `docker compose up/restart/stop/down`,
- `docker inspect` oder `docker ps` im Execution-Core,
- `docker rm` / `docker volume`,
- `.env`-Replace,
- Service-Recreate.

Docker-Live-Evidence kommt ausschließlich über den bereits gemergten read-only Baseline-Pfad.

## Nächster Slice

Nach `CUTOVER_START_VERIFIED` kann der bounded Host-Executor implementiert werden.

Der erste mutierende Executor muss:

1. CUTOVER_STARTED + Live-Baseline unmittelbar erneut prüfen,
2. nur `app`, `export-cleanup`, `retention-scan` recreaten,
3. `libsql` und `caddy` anhand der Baseline-ID unverändert erhalten,
4. nach jeder mutierenden Phase signierte Folge-Evidence persistieren,
5. App-Health und Background-Running-State prüfen,
6. die tatsächlich laufenden neuen Recreate-Container auf `PRIVACY_BACKUP_STATE=ENABLED` attestieren,
7. erst dann echte terminale Completion / `activationExecuted=true` erzeugen.

Bei jedem Fehler muss vor Rückmutation durable Rollback-Evidence persistiert werden; anschließend `.env` bytegenau zurück, die drei Recreate-Services auf DISABLED neu erzeugen und der laufende DISABLED-State verifiziert werden.

`PRIVACY_BACKUP_STATE=DISABLED` bleibt bis zu diesem Live-Cutover und dem praktischen Drill die Release-Grenze.
