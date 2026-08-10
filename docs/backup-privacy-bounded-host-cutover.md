# Backup Privacy Bounded Host Cutover

## Zweck

Dieser Slice ist die erste Schicht der Backup-Privacy-Aktivierung, die tatsächlich Docker-Services mutieren darf. Er bleibt deshalb absichtlich klein, explizit aufzurufen und vollständig an die zuvor signierte Evidence-Kette gebunden.

Er ist **kein** automatischer Deploy- oder Release-Schritt.

## Eingangs-Trust-Chain

Der Host-Executor akzeptiert ausschließlich bereits vorhandene signierte Artefakte:

```text
Activation Plan v2
  -> TARGET_HANDOFF_VERIFIED
  -> gated Service Cutover Plan v2
  -> Service Live Baseline v2
  -> SERVICE_LIVE_BASELINE_VERIFIED
  -> Execution Journal v2
  -> CUTOVER_STARTED
  -> privacy-check
  -> signed Preflight Proof
  -> bounded Docker mutation
  -> signed Live Runtime Attestation
  -> COMPLETED | ROLLBACK_VERIFIED
```

Env-, Compose-, Activation-Plan-, PENDING- und Target-Handoff-Pfade werden nicht frei aus der Kommandozeile übernommen, sondern aus dem HMAC-signierten Service-Cutover-Plan v2 abgeleitet.

## Harte Service-Grenze

Mutierbar sind ausschließlich:

```text
export-cleanup
retention-scan
app
```

`libsql` und `caddy` sind Preserve-Services und werden niemals als `docker compose up`-Ziel an den Executor übergeben.

Jeder Recreate verwendet:

```text
docker compose ... up -d --no-deps --force-recreate --no-build --pull never <service>
```

Damit werden keine Abhängigkeiten mitrecreated, keine Images gebaut und keine neuen Images gepullt.

Die Runtime-Reihenfolge setzt die Background-Services vor `app`, sodass der öffentliche App-Recreate zuletzt erfolgt.

## Fresh Run

Bei einem neuen Cutover ohne vorhandenes Execution-Journal:

1. aktuelle fünf Container werden read-only aufgelöst und privat per `docker inspect` erfasst,
2. die Live-Baseline v2 wird **frisch** unabhängig gegen diesen Hostzustand verifiziert,
3. deren private Verifier-Ausgabe wird persistiert,
4. das Execution-Journal v2 wird daraus erstellt,
5. `CUTOVER_STARTED` wird durable geschrieben,
6. die Target-`.env` und der kanonische Target-Compose-Render werden erneut gegen den signierten Plan geprüft,
7. `privacy-check` wird als One-shot mit `--no-deps` ausgeführt,
8. dessen Ausgabe wird in den signierten Preflight-Proof überführt und unabhängig geprüft,
9. erst dann darf der erste Runtime-Service recreated werden.

## Preflight vor Mutation

Der Executor führt den plan-gebundenen One-shot-Service aus:

```text
docker compose ... run --rm --no-deps -T privacy-check
```

Ein non-zero Exit oder eine Policy-Ausgabe, die den signierten Preflight-Proof nicht erfüllt, führt zu keinem Target-Recreate.

Der Preflight-Proof muss bereits existieren, wenn auf einem Retry ein partiell mutierter Runtime-State sichtbar ist. Er wird dann nur noch verifiziert und niemals rückwirkend neu erzeugt.

Fehlt er nach sichtbarer Mutation, stoppt der Executor fail-closed.

## Target-Recreate und Crash/Retry

Vor jedem Recreate fragt der Host erneut die #244-State-Machine ab. Nur bei

```text
READY_TO_RECREATE_TARGET
serviceMutationAllowed=true
```

wird ein weiterer Service verändert.

Bereits vollständig auf Target stehende Services werden auf Retry übersprungen. Dadurch kann ein Prozess-Crash unmittelbar nach einem erfolgreichen Recreate nicht zu einem doppelten Recreate führen.

Wenn alle drei Services bereits Target sind, aber `TARGET_RECREATED` fehlt, wird ausschließlich das fehlende Event nachgezogen (`RECOVER_TARGET_RECREATED`).

## Health- und Preserve-Grenzen

Nach jedem Recreate wird der Container erneut über Compose-Projekt-/Service-Labels aufgelöst.

- `app` muss `running` und `healthy` werden,
- Background-Services müssen `running` sein,
- `libsql` und `caddy` bleiben über die #244-State-Machine an ihre Baseline-Identität gebunden,
- alle vier Anwendungsdaten-Volumes und Caddy Data/Config bleiben unverändert.

Jede nicht beweisbare Lage blockiert weitere Mutation.

## Signierte Live-Runtime-Attestation

Nach vollständigem Target-Recreate erzeugt und prüft der Host die #245-Attestation gegen frisch gesammelte Inspect-Evidence.

Damit müssen insbesondere alle mutable Services tatsächlich tragen:

```text
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
PRIVACY_NOTIFICATIONS_STATE=DISABLED
```

Erst danach wird `LIVE_VALIDATED` geschrieben. Nur anschließend darf `COMPLETED` terminal `activationExecuted=true` setzen.

## Automatischer Rollback

Ein kontrollierbarer Fehler nach `CUTOVER_STARTED` löst nur dann automatischen Rollback aus, wenn die aktuelle #244-Evidence weiterhin eine bekannte und sichere Rollback-Richtung erlaubt.

Vor der ersten Reverse-Mutation wird durable geschrieben:

```text
ROLLBACK_STARTED
```

Danach:

1. wird die Target-`.env` über den signierten Activation-Plan-v2-Rollback **bytegenau** auf den ursprünglichen Pre-State zurückgeführt,
2. der DISABLED-Policy-State dieser Bytes wird erneut verifiziert,
3. nur mutable Services, die noch `ENABLED` sind, werden mit der zurückgerollten `.env` recreated,
4. bereits `DISABLED` laufende Services werden nicht unnötig recreated,
5. `ROLLBACK_RECREATED` wird nach vollständigem DISABLED-Runtime-State nachgezogen,
6. eine signierte #245-`DISABLED`-Runtime-Attestation wird erzeugt und geprüft,
7. erst danach wird `ROLLBACK_VERIFIED` terminal persistiert.

Der sichere Rollback endet bei:

```text
activationExecuted=false
serviceCutoverExecuted=false
```

## Fail-closed statt Blind-Rollback

Nicht jede Störung darf automatisch rückmutiert werden. Wenn Preserve-Identität, Volumes oder Runtime-Zustand nicht mehr beweisbar sind, blockiert der Executor, statt einen weiteren unbekannten Zustand zu erzeugen.

Ebenso blockiert er, wenn nach einem realen Prozess-Crash bereits Mutation sichtbar ist, aber der historische signierte Preflight-Proof fehlt.

## Evidence-Verzeichnisse

Execution-Journal und Events liegen weiterhin ausschließlich im privaten, vom #244-Core kontrollierten Journal-Verzeichnis.

Andere Artefakte werden außerhalb davon abgelegt, damit die append-only Journal-Whitelist unverändert bleibt:

- Baseline-Verifier-Ausgabe,
- read-only Inspect-Snapshots,
- privacy-check-Ausgabe,
- Preflight-Proof,
- Target-/Rollback-Runtime-Attestations.

Alle Evidence-Verzeichnisse werden `0700`, Dateien `0600` angelegt.

## CI-Contract

Der Host-Contract verwendet die echte signierte Kette bis #246 und ersetzt erst danach den Docker-Client durch einen stateful Simulator. So werden die Host-Orchestrierung und die echten Evidence-Tools gemeinsam getestet, ohne einen produktiven Club-Stack zu verändern.

Geprüft werden mindestens:

- Erfolgspfad mit exakt einem Target-Recreate je mutable Service,
- `privacy-check` vor dem ersten Recreate,
- niemals `libsql`/`caddy` als Mutationstarget,
- echter Prozessabbruch direkt nach dem ersten Recreate,
- Retry ohne Doppel-Recreate und ohne zweiten Preflight,
- fehlender Preflight-Proof nach sichtbarer Mutation -> keine weitere Mutation,
- kontrollierter Recreate-Fehler nach partiellem Target-State,
- sticky `ROLLBACK_STARTED`,
- bytegenauer `.env`-Rollback,
- DISABLED-Recreate nur der tatsächlich zurückzurollenden Services,
- terminal `ROLLBACK_VERIFIED`.

## Noch keine reale Freigabe

Dieser PR beweist den bounded Host-Algorithmus in CI. Er führt keinen produktiven Host-Cutover aus und schließt keine praktischen Restore-/RTO-Gates.

`.env.example` bleibt daher weiterhin:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

## Nächster Schritt nach Merge

Nach grünem Merge folgt **nicht** sofort das globale Release-Gate. Zuerst muss der Executor auf dem vorgesehenen Host in einem ausdrücklich kontrollierten Drill mit realem Backup/Restore, dokumentiertem RTO und vollständiger Evidence-Kette ausgeführt werden. Erst ein erfolgreicher praktischer Drill kann die weiterhin offenen TASKS-/Release-Gates begründet schließen.