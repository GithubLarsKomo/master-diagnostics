# Backup Privacy Service Cutover Execution Evidence v1

## Zweck

Nach Service Cutover Plan v2 und signierter Live Baseline existiert erstmals eine vollständige Pre-Mutation-Autorisierung. Vor einem tatsächlichen Docker-Recreate fehlt aber noch eine crash-/retry-sichere Execution-Evidence.

Dieser Slice definiert diese Evidence und eine read-only Zustandsmaschine. Er führt **keinen** Docker-Befehl aus und ändert keine `.env`.

```text
TARGET_HANDOFF_VERIFIED
  -> Service Cutover Plan v2
  -> signed Live Baseline
  -> signed Execution Journal
  -> CUTOVER_STARTED
  -> späterer bounded Recreate
```

## Unabhängige Post-Mutation-Authentifizierung

Nach einem späteren Recreate darf der Pre-Mutation-Baseline-Checker nicht erneut als Istzustandsprüfung verwendet werden, weil die mutable Container-IDs und ihr Privacy-State dann absichtlich verändert sind.

Die Execution-Schicht verifiziert deshalb immutable Evidence unabhängig:

- Service Cutover Plan v2 HMAC/Fingerprint,
- Live Baseline HMAC/Fingerprint,
- vollständigen Plan-Dateihash aus der Baseline,
- Journal-HMAC/Fingerprint,
- Event-HMAC-Kette.

Danach werden neue Docker-Inspect-Daten nur noch gegen die signierten Grenzen klassifiziert.

## Durable Execution Journal

Domain:

```text
masters:backup-privacy-service-cutover-execution-journal:v1
```

Das Journal bindet u. a.:

- `activationId`, `cutoverId`, `baselineId`,
- v2-Cutover-Plan-Fingerprint und vollständigen Dateihash,
- Baseline-Fingerprint, vollständigen Dateihash und HMAC,
- Baseline-`liveFingerprint`,
- Target-Privacy-Environment,
- exakt die drei Recreate-Services,
- exakt `libsql` und Caddy als preserved Services.

Safety-Felder:

```text
phase=PENDING
journalRequiredBeforeMutation=true
rollbackStartedRequiredBeforeReverseMutation=true
preservedIdentityRequiredThroughout=true
dataVolumesMustRemainBound=true
serviceMutationStarted=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Das Journal muss entstehen, solange die signierte Live Baseline noch exakt aktiv ist.

## Append-only Execution Events

Eigene Domain:

```text
masters:backup-privacy-service-cutover-execution-event:v1
```

Zulässige Pfade:

### Erfolg

```text
CUTOVER_STARTED
  -> TARGET_RECREATED
  -> LIVE_VALIDATED
  -> COMPLETED
```

### Rollback

```text
CUTOVER_STARTED
  -> ROLLBACK_STARTED
  -> ROLLBACK_RECREATED
  -> ROLLBACK_VERIFIED
```

oder nach bereits vollständigem Target-Recreate:

```text
CUTOVER_STARTED
  -> TARGET_RECREATED
  -> ROLLBACK_STARTED
  -> ROLLBACK_RECREATED
  -> ROLLBACK_VERIFIED
```

`ROLLBACK_STARTED` darf auch nach `LIVE_VALIDATED` entstehen, solange noch kein terminales `COMPLETED` existiert.

Jedes Event bindet:

- lückenlose Sequenz,
- Journal-Fingerprint und -HMAC,
- Signatur des vorherigen Events,
- Activation/Cutover/Baseline-Identität,
- technische Live-Attestation bei `LIVE_VALIDATED` bzw. `ROLLBACK_VERIFIED`,
- terminale Semantik.

`activationExecuted=true` ist ausschließlich in `COMPLETED` erlaubt.

## Live-Klassifikation

Die aktuelle Runtime wird aus neuen Inspect-Daten gegen die Baseline klassifiziert.

### Unveränderliche Grenzen

Für alle Zustände müssen weiterhin gelten:

- identisches Compose-Projekt,
- identische Image-ID und Image-Referenz aller fünf Services,
- preserved `libsql`-/Caddy-Container-IDs unverändert,
- `libsql` running + healthy,
- Caddy running,
- mutable Services running, App zusätzlich healthy,
- alle vier Named Data Volumes exakt unverändert,
- `export-cleanup` teilt weiterhin Export-/Delivery-Volumes mit App.

Jede Abweichung ergibt `UNKNOWN` und blockiert.

### Mutable Zustände

Jeder mutable Service ist ausschließlich:

- `DISABLED`: `PRIVACY_BACKUP_STATE=DISABLED`, keine Target-only-Backup-Variablen,
- `ENABLED`: alle fünf Targetwerte exakt vorhanden,
- sonst `UNKNOWN`.

Daraus entstehen vier technische Live-Klassen:

- `BASELINE`: alle DISABLED, originale Baseline-Container-IDs,
- `ROLLBACK`: alle DISABLED, aber nach Recreate neue mutable Container-IDs,
- `TARGET`: alle ENABLED,
- `MIXED_KNOWN`: bekannte Mischung aus DISABLED/ENABLED,
- `UNKNOWN`: jede nicht autorisierte Abweichung.

## Crash-/Retry-Zustände

### Vor Mutation

Kein Event + `BASELINE`:

```text
READY_TO_START
```

Erst hier darf `CUTOVER_STARTED` persistiert werden.

### Crash während Target-Recreate

`CUTOVER_STARTED + MIXED_KNOWN`:

```text
READY_TO_RECREATE_TARGET
```

Der spätere Executor darf nur weiter in die Target-Richtung konvergieren.

### Target-Recreate fertig, Event fehlt

`CUTOVER_STARTED + TARGET`:

```text
RECOVER_TARGET_RECREATED
```

Der fehlende `TARGET_RECREATED`-Event wird nachgezogen; kein erneuter Recreate ist nötig.

### Ziel vollständig aktiv

`TARGET_RECREATED + TARGET`:

```text
READY_TO_VALIDATE_LIVE
```

Erst eine technische Live-Attestation erlaubt `LIVE_VALIDATED`.

Danach:

```text
READY_TO_COMPLETE
```

und erst `COMPLETED` setzt `activationExecuted=true`.

### Rollback-Richtung

`ROLLBACK_STARTED` wird **vor** jeder späteren Reverse-Mutation persistiert.

Bei `TARGET` oder `MIXED_KNOWN`:

```text
READY_TO_RECREATE_ROLLBACK
```

Wenn alle drei mutable Services bereits wieder DISABLED sind, aber der Folgeevent fehlt:

```text
RECOVER_ROLLBACK_RECREATED
```

Danach folgt `ROLLBACK_RECREATED`, technische DISABLED-Live-Attestation und terminal `ROLLBACK_VERIFIED`.

## Warum `ROLLBACK_STARTED` zwingend ist

Ohne ein persistiertes Richtungs-Event könnte ein Crash nach manueller/externer Rückschaltung nicht von einem autorisierten Rollback unterschieden werden.

Darum gilt:

```text
DISABLED-Recreate nach CUTOVER_STARTED ohne ROLLBACK_STARTED = BLOCKED
```

Der Executor darf den Rückweg niemals allein aus dem aktuellen Live-State erraten.

## CI-Vertrag

Der Contract baut zunächst die echte Target-Handoff-, Cutover-Plan-v2- und Live-Baseline-Kette auf. Danach werden ausschließlich technische Inspect-Fixtures verwendet.

Bewiesen werden:

- Journal nur auf exakt aktiver Baseline,
- `CUTOVER_STARTED` vor jeder Target-Mutation,
- partiell bekannte Target-Recreates,
- Crash nach vollständigem Target-Recreate vor Event,
- technische Attestation vor `LIVE_VALIDATED`,
- terminal `COMPLETED` erst danach,
- sticky `ROLLBACK_STARTED`,
- partieller Rollback,
- Crash nach vollständigem DISABLED-Recreate vor Folgeevent,
- technische DISABLED-Attestation vor terminalem Rollback,
- preserved-ID- und Data-Volume-Drift blockieren,
- Event-HMAC-Tampering blockiert,
- Evidence bleibt frei von unrelated Env-Secrets.

## Nächster Slice

Erst nach diesem Execution-Evidence-Contract folgt der tatsächliche bounded Docker-Executor.

Er muss die Zustandsmaschine mechanisch ausführen und darf nur in Zuständen mit `serviceMutationAllowed=true` Docker mutieren. Konkret:

1. `READY_TO_START` -> nur `CUTOVER_STARTED` schreiben,
2. `READY_TO_RECREATE_TARGET` -> ausschließlich `app`, `export-cleanup`, `retention-scan` zum gebundenen Target-Compose recreaten,
3. `RECOVER_TARGET_RECREATED` -> nur fehlenden Event schreiben,
4. `READY_TO_VALIDATE_LIVE` -> echte Live-Inspect/Health/Environment-Attestation,
5. erst nach `LIVE_VALIDATED` terminal `COMPLETED`,
6. bei Fehlern zuerst `ROLLBACK_STARTED`,
7. danach Plan-v2-Env-Rollback und Recreate derselben drei Services auf DISABLED,
8. preserved Services und Datenvolumes erneut prüfen,
9. technische DISABLED-Live-Attestation,
10. terminal `ROLLBACK_VERIFIED`.

Dieser Slice selbst verändert keine produktive Runtime. `.env.example` bleibt DISABLED und die praktischen Restore-/RTO-/Release-Gates bleiben offen.
