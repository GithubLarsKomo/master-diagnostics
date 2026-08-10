# Backup Privacy Service Cutover Preflight Proof

## Zweck

Die Service-Cutover-State-Machine aus #244 schreibt `CUTOVER_STARTED` durable vor die erste Service-Mutation. Ohne einen zusätzlichen Beleg bliebe nach einem Crash jedoch eine kleine Beweislücke: Ein später sichtbarer Target-State könnte als „Mutation outran evidence“ eingeordnet werden, obwohl nicht mehr beweisbar wäre, dass der vorgeschriebene `privacy-check` **vor** dem ersten Recreate erfolgreich war.

Dieser Slice schließt genau diese Lücke mit einem HMAC-signierten, historisch verifizierbaren Preflight-Proof.

Er führt selbst weder Docker noch Compose aus und mutiert keine Services oder Environment-Dateien.

## Reihenfolge

Der Proof darf nur in dieser Reihenfolge erstmals entstehen:

```text
SERVICE_LIVE_BASELINE_VERIFIED
  -> Execution Journal v2
  -> durable CUTOVER_STARTED
  -> privacy-check gegen den gestagten Target-State
  -> signierter Preflight-Proof
  -> erst danach erster Target-Recreate
```

`CUTOVER_STARTED` muss bereits als signiertes Event mit Sequenz 1 vorliegen. Gleichzeitig muss der tatsächliche Runtime-Istzustand noch exakt `BASELINE` sein. Ein bereits partieller oder vollständiger Recreate blockiert die **erstmalige** Proof-Erzeugung fail-closed.

## Privacy-Check

Der spätere Host-Executor führt den im Cutover-Plan festgelegten One-shot-Service `privacy-check` aus. Der Proof-Writer konsumiert ausschließlich dessen private JSON-Ausgabe.

Akzeptiert wird nur:

```text
readyForIrreversibleProcessing=true
backupState=ENABLED
backupPolicyVersion=1.0.0
notificationsState=DISABLED
blockers=[]
```

Die Ausgabe darf nur die kanonischen Privacy-Policy-Felder enthalten. Unerwartete Felder werden abgelehnt, damit der Proof nicht versehentlich zusätzliche Daten oder Secrets übernimmt.

## Signing Domain

```text
masters:backup-privacy-service-cutover-preflight:v1
```

Der signierte Record bindet insbesondere:

- Activation-, Cutover- und Baseline-ID,
- Cutover-Plan-, Baseline-, Target-Handoff- und Journal-Fingerprint,
- den `liveStateFingerprint` der signierten Pre-Mutation-Baseline,
- Pfad, Datei-SHA und HMAC-Signatur des sequence-1-`CUTOVER_STARTED`-Events,
- Pfad und SHA-256 der privaten `privacy-check`-Ausgabe,
- die validierten Backup-/Notifications-Policy-Felder,
- `preflightVerifiedBeforeMutation=true`,
- `targetMutationAuthorized=true`,
- `serviceMutationObserved=false`,
- `activationExecuted=false`.

Proof-Datei und Output-Verzeichnis bleiben privat (`0600` bzw. `0700`).

## Historische Retry-Eigenschaft

Der Proof ist kein Snapshot des **späteren** Live-State. Er belegt einen konkreten historischen Sachverhalt:

> Nach durablem `CUTOVER_STARTED`, aber noch vor der ersten Service-Mutation, war die signierte Baseline weiterhin aktiv und der plan-gebundene Target-Privacy-Preflight erfolgreich.

Deshalb bleibt der Proof auf einem Retry auch dann verifizierbar, wenn inzwischen `TARGET_RECREATED` oder weitere Execution-Events existieren. Der Checker verifiziert weiterhin die unveränderliche sequence-1-`CUTOVER_STARTED`-Evidence, die ursprünglichen Preflight-Bytes und die statische Cutover-/Baseline-/Journal-Bindung.

Diese historische Gültigkeit **autorisiert nicht automatisch weitere Mutationen**. Die aktuelle Richtung bleibt ausschließlich Aufgabe der #244-State-Machine:

- `READY_TO_RECREATE_TARGET` erlaubt Target-Fortsetzung,
- `RECOVER_TARGET_RECREATED` erlaubt nur Evidence-Nachziehen,
- nach `ROLLBACK_STARTED` ist Target-Fortsetzung verboten,
- `UNKNOWN` bleibt immer fail-closed.

Der spätere Host-Executor muss daher immer sowohl den Preflight-Proof als auch das aktuelle Execution-Assessment prüfen.

## Crash-Grenze

Damit ergibt sich für den ersten mutierenden Host-Slice:

```text
CUTOVER_STARTED persisted
  -> privacy-check success
  -> signed preflight proof persisted + checked
  -> crash-safe authorization boundary complete
  -> first docker compose force-recreate may begin
```

Fehlt der Proof nach einem Crash, darf ein Host-Retry keine weitere Target-Mutation ausführen. Ist bereits ein veränderter Live-State sichtbar, kann der Proof auch nicht nachträglich erzeugt werden; das muss als operative Ausnahme fail-closed behandelt werden statt die Historie rückwirkend zu behaupten.

## Scope

Dieser Slice ist evidence-only. Er enthält keine Docker-, Compose-, `subprocess`- oder Filesystem-Replacement-Primitive. Die CI erzeugt synthetische Inspect-Evidence und eine kanonische `privacy-check`-JSON-Ausgabe.

`.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`. Restore-/RTO- und reale Release-Gates bleiben offen.

## Nächster Slice

Der bounded Host-Executor muss unmittelbar vor dem ersten Recreate:

1. Baseline und Execution-Journal erneut verifizieren,
2. `CUTOVER_STARTED` durable persistieren,
3. `privacy-check` als One-shot gegen den gestagten Target-State ausführen,
4. den signierten Preflight-Proof erzeugen und unabhängig prüfen,
5. erst dann anhand des aktuellen #244-Assessments die erlaubte Target-Mutation ausführen.

Auf Retries muss er den vorhandenen Proof wiederverwenden und darf ihn niemals nach bereits sichtbarer Mutation neu erzeugen.