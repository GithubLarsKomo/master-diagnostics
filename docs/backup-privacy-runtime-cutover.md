# Backup Privacy Live Runtime Cutover Journal v1

## Zweck

Nach #226 kann die gebundene Club-`.env` bereits atomar auf `PRIVACY_BACKUP_STATE=ENABLED` stehen und eine signierte `COMPLETED`-Evidence besitzen. Bereits laufende Container können aber weiterhin mit dem alten DISABLED-Environment arbeiten.

Dieser Slice schließt **noch nicht** diese Prozessumschaltung. Er erzeugt zuerst die dauerhafte, signierte Pre-Mutation-Evidence für einen späteren Service-Recreate und stellt eine read-only Zustandsbewertung bereit.

Damit sind Dateikonfiguration und tatsächlich laufende Runtime ausdrücklich getrennt:

```text
#226 file activation COMPLETED
  -> #227 completion authentication
  -> signed live runtime cutover PENDING journal
  -> read-only live container assessment
  -> späterer bounded service recreate
```

## Authentifizierter #226-Abschluss

`check-backup-privacy-activation-completion.py` verifiziert erneut:

- Activation Plan v2,
- #225-PENDING-Evidence,
- #226-HMAC-`COMPLETED`-Marker,
- das Fehlen konkurrierender #226-Rollback-Marker,
- Plan-/Execution-/Marker-Bindung.

Die immutable Completion-Evidence bleibt auch nach einem späteren Host-Rollback authentifizierbar. Der Checker trennt deshalb:

- `envState=TARGET`,
- `envState=PRE_ACTIVATION`,
- `envState=DRIFT`.

Nur `TARGET` liefert `runtimeCutoverAllowed=true`.

## Pre-Live-Bindung

Vor einer Service-Mutation müssen genau fünf vorhandene Club-Container read-only erfasst werden:

- `app`,
- `export-cleanup`,
- `retention-scan`,
- `libsql`,
- `caddy`.

Alle fünf müssen zum selben Compose-Projekt gehören und laufen. `app` und `libsql` müssen zusätzlich `healthy` sein.

Die drei später neu zu erzeugenden Services müssen noch exakt den alten Backup-State tragen:

```text
app             -> PRIVACY_BACKUP_STATE=DISABLED
export-cleanup  -> PRIVACY_BACKUP_STATE=DISABLED
retention-scan  -> PRIVACY_BACKUP_STATE=DISABLED
```

Ein bereits ENABLED laufender Prozesssatz ohne vorheriges Journal wird nicht nachträglich autorisiert.

`libsql` und Caddy werden als preserved container IDs gebunden. Der spätere Executor darf diese beiden Container nicht recreaten.

## Signiertes PENDING Journal

Standardpfad:

```text
/var/lib/master-diagnostics/backup-privacy-runtime-cutovers/<activationId>/runtime-cutover-pending.json
```

HMAC-Domain:

```text
masters:backup-privacy-runtime-cutover:v1
```

Das Journal bindet:

- `activationId`, `executionId`, `executionFingerprint`,
- Plan-Fingerprint,
- #226-Completion-Marker SHA-256 und HMAC,
- SHA-256 der #226-File-Runtime-Attestation,
- absoluten `.env`-Pfad,
- Pre-/Target-Fingerprint,
- Compose-Projekt,
- exakte IDs der drei noch DISABLED laufenden mutable Services,
- exakte preserved IDs von `libsql` und Caddy,
- einen kanonischen `preLiveFingerprint`,
- die feste Recreate-Menge,
- Target `ENABLED`, Rollback `DISABLED`,
- Rollback-Policy `RESTORE_PLAN_V2_ENV_AND_RECREATE_MUTABLE_SERVICES`,
- `runtimeMutationStarted=false`,
- `liveRuntimeChanged=false`,
- `operationalActivationCompleted=false`.

Root und activation-spezifisches Verzeichnis sind `0700`, das Journal `0600`.

## Read-only Live Assessment

`backup-privacy-runtime-cutover.py check` vergleicht das signierte Journal mit neuen Docker-Inspect-Daten.

### `READY_TO_CUTOVER`

- `.env` ist weiterhin TARGET,
- `libsql` und Caddy haben unverändert die gebundenen IDs,
- alle drei mutable Services sind weiterhin DISABLED,
- deren Container-IDs und der vollständige Pre-Live-Fingerprint entsprechen dem Journal.

Nur dieser Zustand ist ein sauberer erster Mutationspunkt.

### `READY_TO_VALIDATE`

- `.env` ist TARGET,
- preserved Services sind unverändert,
- alle drei mutable Services laufen bereits mit der vollständigen Backup-Policy v1 im ENABLED-State.

Dieser Zustand ist der erwartete Post-Recreate-/Crash-Recovery-Zustand. Das Assessment selbst erklärt die Runtime noch nicht operational aktiviert; ein späterer Executor muss daraus eine signierte terminale Live-Attestation erzeugen.

### `RECOVER_TARGET_RECREATE`

Jeder mutable Service verwendet ausschließlich einen bekannten Zustand, aber der Satz ist gemischt DISABLED/ENABLED. Das deckt einen Crash während eines späteren Recreate ab. Der zukünftige Executor darf in dieser Lage nur in die journalgebundene ENABLED-Richtung konvergieren.

### Blocker

Fail-closed sind insbesondere:

- unbekannte/missing Privacy-States,
- andere Compose-Projekte,
- nicht laufende Services,
- ungesunder `app` oder `libsql`,
- geänderte `libsql`-/Caddy-IDs,
- geänderte Pre-Cutover-IDs vor dem ersten Recreate,
- Env-Fingerprint-Drift,
- HMAC-/Fingerprint-Tampering.

Wenn die `.env` bereits wieder exakt PRE_ACTIVATION ist, meldet das Assessment `ENV_PRE_ACTIVATION`; es leitet daraus ohne spätere Rollback-Evidence keine neue Richtung ab.

## Host-Wrapper

```bash
bash infra/backup/prepare-club-backup-privacy-runtime-cutover.sh \
  /absolute/activation-plan.json \
  /absolute/activation-execution-pending.json \
  /absolute/activation-key
```

Der Wrapper:

1. validiert Plan/PENDING/Key/`.env`,
2. rendert die bestehende Club-Compose-Konfiguration nur read-only,
3. löst für jeden der fünf Services genau einen vorhandenen Container via `docker compose ps -a -q`,
4. liest ausschließlich `docker inspect`,
5. löst alle IDs nach der Inspect-Erfassung nochmals auf und blockiert bei Race/Drift,
6. übergibt nur diese technische Evidence an den Python-Journal-Writer.

Es gibt in diesem Slice kein `compose up/down/stop/restart`, keine Volume-Mutation und keinen `.env`-Write.

Für isolierte Tests kann `BACKUP_PRIVACY_RUNTIME_ENV_FILE` einen anderen **signiert plan-gebundenen** Env-Pfad setzen. Standard bleibt `<repo>/.env`.

## CI-Vertrag

Der spezialisierte Contract beginnt mit dem echten #226-Executor-Test und verwendet dessen vollständig signierte `COMPLETED`-Fixture. Danach werden ausschließlich technische Docker-Inspect-Fixtures verwendet.

Bewiesen werden:

- unabhängige #226-Completion-Authentifizierung,
- Journal-Erzeugung nur bei tatsächlich noch DISABLED laufenden mutable Services,
- idempotenter Retry,
- `0700`/`0600`,
- `READY_TO_CUTOVER`,
- vollständig ENABLED -> `READY_TO_VALIDATE`,
- partiell bekannter Recreate -> `RECOVER_TARGET_RECREATE`,
- mutable Pre-ID-Drift blockiert,
- `libsql`-/Caddy-ID-Drift blockiert,
- ENABLED-Live-State ohne Journal blockiert,
- HMAC-Tampering blockiert,
- Host-Wrapper mit stabiler Mock-Docker-Identität bleibt vollständig read-only,
- keine übrigen `.env`-Secrets gelangen in das Journal.

## Nächster Slice

Der nächste sichere Slice ist der bounded Runtime-Recreate-Executor. Er muss:

1. exakt dieses Journal vor der ersten Docker-Mutation verifizieren,
2. eine eigene `CUTOVER_STARTED`-Evidence vor dem Recreate persistieren,
3. ausschließlich `app`, `export-cleanup` und `retention-scan` recreaten,
4. `libsql` und Caddy unverändert lassen,
5. `READY_TO_VALIDATE` durch eine technische Live-Attestation terminalisieren,
6. bei Fehler zuerst `ROLLBACK_STARTED` persistieren,
7. die `.env` bytegenau aus Plan v2 zurücksetzen,
8. dieselben drei Services in DISABLED neu erzeugen,
9. preserved IDs sowie DISABLED-Live-State erneut attestieren,
10. erst danach `ROLLED_BACK` terminal signieren.

`PRIVACY_BACKUP_STATE=DISABLED` in `.env.example`, die praktischen RTO-/Restore-Gates und der reale Host-State bleiben durch diesen PR unverändert.
