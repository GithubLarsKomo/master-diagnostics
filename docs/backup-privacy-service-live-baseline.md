# Backup Privacy Service Live Baseline v1

## Zweck

Der Service Cutover Plan v2 beschreibt den autorisierten Sollzustand nach dem nichtterminalen Target-Handoff. Unmittelbar vor einer späteren Docker-Mutation muss zusätzlich der tatsächliche Istzustand der noch laufenden Club-Services unveränderlich gebunden werden.

Die Live Baseline ist genau diese letzte Pre-Mutation-Evidence:

```text
TARGET_HANDOFF_VERIFIED
  -> Service Cutover Plan v2
  -> signed Service Live Baseline
  -> später: CUTOVER_STARTED + bounded service recreate
```

Sie führt selbst keinen Service-Recreate und keine `.env`-Mutation aus.

## Autorisierung

Vor Baseline-Erzeugung wird der Service Cutover Plan v2 erneut mit seinem unabhängigen Checker verifiziert. Damit werden erneut geprüft:

- Target-Handoff,
- Target-Env-Fingerprint,
- Plan/PENDING/Handoff-Dateibindungen,
- Compose-Dateihash,
- kanonischer Target-Compose-Render,
- `authorizationSource=TARGET_HANDOFF_VERIFIED`,
- `liveBaselineRequiredBeforeMutation=true`,
- weiterhin `activationExecuted=false`.

## Gebundene Live-Prozesse

Die Baseline erfasst exakt fünf vorhandene Compose-Services:

- `app`,
- `export-cleanup`,
- `retention-scan`,
- `libsql`,
- `caddy`.

Alle müssen:

- zum selben Compose-Projekt gehören,
- eindeutig über Container-ID identifiziert sein,
- `running` sein.

Zusätzlich müssen `app` und `libsql` `healthy` sein.

Für jeden Service werden technische Identitäten gebunden:

- Container-ID,
- Docker Image-ID,
- Image-Referenz,
- Running-/Health-State.

## Mutable Services müssen noch DISABLED sein

Die drei später zu recreatenden Services

```text
app
export-cleanup
retention-scan
```

müssen vor Baseline-Erzeugung tatsächlich mit

```text
PRIVACY_BACKUP_STATE=DISABLED
```

laufen.

Die vier Target-only Backup-Privacy-Variablen dürfen in diesen laufenden Prozessen noch nicht vorhanden sein:

- `PRIVACY_BACKUP_POLICY_VERSION`,
- `PRIVACY_BACKUP_ENCRYPTED_AT_REST`,
- `PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED`,
- `PRIVACY_BACKUP_RESTORE_RECONCILIATION`.

Ein bereits ENABLED laufender Prozesssatz kann daher nicht nachträglich als legitime Pre-Mutation-Baseline signiert werden.

## Preserved Services

`libsql` und Caddy sind keine Recreate-Ziele dieses Aktivierungsschritts. Ihre aktuellen Container- und Image-Identitäten werden deshalb als preserved Baseline gebunden.

Ein späterer Executor muss beweisen, dass diese Identitäten während des Cutovers unverändert bleiben.

## Aktive Daten-Volumes

Vier aktuell tatsächlich gemountete Named Volumes werden rollenbezogen gebunden:

1. `LIBSQL` -> `/var/lib/sqld`
2. `REPORTS` -> `/var/lib/masters/reports`
3. `TENANT_EXPORTS` -> `/var/lib/masters/exports`
4. `DATA_SUBJECT_DELIVERY` -> `/var/lib/masters/data-subject-delivery-packages`

Jedes Volume muss:

- genau einmal für die Rolle auflösbar sein,
- ein Named Volume sein,
- read-write gemountet sein,
- einen sicheren Docker-Volume-Namen besitzen,
- von den anderen drei Datenrollen verschieden sein.

Zusätzlich muss `export-cleanup` dieselben Tenant-Export- und Data-Subject-Delivery-Volumes wie `app` verwenden. Dadurch wird nicht nur die Prozessidentität, sondern auch die gemeinsam verwendete persistente Datenbasis abgesichert.

## HMAC-Evidence

Domain:

```text
masters:backup-privacy-service-live-baseline:v1
```

Standardpfad:

```text
/var/lib/master-diagnostics/backup-privacy-service-live-baselines/<cutoverId>/service-live-baseline.json
```

Gebunden werden u. a.:

- `cutoverId`, `activationId`,
- v2-Cutover-Plan-Fingerprint,
- vollständiger v2-Plan-Dateihash,
- gerenderter Compose-Fingerprint,
- Compose-Projekt,
- mutable und preserved Service-Identitäten,
- vier aktive Daten-Volumes,
- kanonischer `liveFingerprint`.

Feste Safety-Grenzen:

```text
phase=PRE_MUTATION
baselineRequiredBeforeMutation=true
allMutableServicesDisabled=true
preservedContainerIdentityRequired=true
activeDataVolumesBound=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Root und Cutover-Verzeichnis sind `0700`, die Evidence-Datei `0600`.

## Read-only Verifikation unmittelbar vor Mutation

Der Baseline-Checker revalidiert:

1. den vollständigen Service Cutover Plan v2,
2. den Baseline-HMAC/Fingerprint,
3. den vollständigen v2-Plan-Dateihash,
4. den aktuellen Istzustand aller fünf Container,
5. deren Container-/Image-IDs,
6. Health/Running-State,
7. DISABLED-Environment der drei mutable Services,
8. die vier aktiven Named Volumes.

Schon eine geänderte App-ID, Caddy-ID oder ein anderer Reports-Volume-Name ergibt fail-closed Live-Drift.

Nur bei vollständiger Übereinstimmung wird ausgegeben:

```text
SERVICE_LIVE_BASELINE_VERIFIED
serviceCutoverMutationAllowed=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Host-Wrapper

```bash
bash infra/backup/prepare-club-backup-privacy-service-live-baseline.sh \
  /absolute/activation-plan.json \
  /absolute/pending.json \
  /absolute/target-handoff.json \
  /absolute/key \
  /absolute/service-cutover-plan-v2.json
```

Der Wrapper nutzt ausschließlich:

- `docker compose ... config --format json`,
- `docker compose ... ps -a -q`,
- `docker inspect`.

Nach dem Einsammeln der Inspect-Evidence löst er alle fünf Container-IDs erneut auf. Wenn sich eine Identität während der Erfassung ändert, wird keine Baseline erzeugt.

Kein `up/down/stop/restart`, keine Volume-Mutation und kein `.env`-Write.

## CI-Vertrag

Der Contract erzeugt zunächst die echte #231-Handoff- und #234-v2-Plan-Kette. Danach werden technische Docker-Inspect-Fixtures verwendet.

Bewiesen werden:

- fünf eindeutige laufende Container desselben Compose-Projekts,
- healthy App/LibSQL,
- tatsächlich DISABLED laufende mutable Services,
- Container- und Image-Bindung,
- vier aktive Named Data Volumes,
- gemeinsames Export-/Delivery-Volume zwischen App und Cleanup-Worker,
- signierte Baseline + deterministischer Retry,
- App-ID-Drift blockiert,
- Caddy-ID-Drift blockiert,
- aktiver Volume-Drift blockiert,
- bereits ENABLED laufende Prozesse können keine Baseline erhalten,
- HMAC/Fingerprint-Tampering blockiert,
- keine unrelated Env-Secrets in Baseline-Evidence.

## Nächster Slice

Erst nach einer verifizierten Live Baseline darf der bounded Service-Recreate-Executor entstehen.

Seine erste Aktion muss eine dauerhafte `CUTOVER_STARTED`-Evidence sein. Danach darf er ausschließlich `app`, `export-cleanup` und `retention-scan` auf Grundlage des bereits gebundenen Target-Compose recreaten.

Nach einem erfolgreichen Recreate muss er:

- die neuen Container tatsächlich als ENABLED attestieren,
- `app` healthy und beide Background-Services running prüfen,
- preserved `libsql`-/Caddy-IDs verifizieren,
- aktive Daten-Volumes gegen die Baseline prüfen,
- erst dann terminal `activationExecuted=true` signieren.

Bei Fehlern muss vor jeder Rückmutation eine dauerhafte Rollback-Evidence existieren; danach sind Plan-v2-Env-Rollback und Recreate der drei Services auf DISABLED nötig.

`.env.example` bleibt DISABLED und die praktischen Restore-/RTO-/Release-Gates bleiben offen.
