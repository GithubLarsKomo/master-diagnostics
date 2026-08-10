# Backup Privacy Bounded Host Cutover

## Zweck

Dieser Slice ist die erste Schicht der Backup-Privacy-Aktivierung, die tatsächlich Docker-Services mutieren darf. Er bleibt deshalb absichtlich klein, explizit aufzurufen und vollständig an die zuvor signierte Evidence-Kette gebunden. Er ist **kein** automatischer Deploy- oder Release-Schritt.

## Eingangs-Trust-Chain

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

Env-, Compose-, Activation-Plan-, PENDING- und Target-Handoff-Pfade werden aus dem HMAC-signierten Service-Cutover-Plan v2 abgeleitet.

## Harte Service-Grenze

Mutierbar sind ausschließlich `export-cleanup`, `retention-scan` und `app`. `libsql` und `caddy` sind Preserve-Services und werden niemals als Recreate-Ziel übergeben.

Jeder Recreate verwendet:

```text
docker compose ... up -d --no-deps --force-recreate --no-build --pull never <service>
```

Background-Services werden vor `app` umgestellt.

## Fresh Run und Observation-Race

Bei einem neuen Cutover:

1. aktuelle fünf Container werden read-only erfasst,
2. die Live-Baseline v2 wird unabhängig gegen den echten Hostzustand verifiziert,
3. **danach** wird der Hostzustand erneut frisch erfasst,
4. erst diese Post-Verifikations-Evidence darf das Execution-Journal erzeugen,
5. nach Journal-Erstellung bzw. -Wiederverwendung wird nochmals frisch beobachtet,
6. `CUTOVER_STARTED` wird durable geschrieben,
7. Target-`.env` und signierter Compose-Render werden erneut geprüft,
8. `privacy-check` wird als One-shot ausgeführt,
9. der signierte Preflight-Proof wird erzeugt und geprüft,
10. erst danach darf der erste Recreate beginnen.

Damit kann ein Restart zwischen Baseline-Check und Journal-Erstellung nicht unbemerkt als alter Pre-State gebunden werden.

## Preflight vor Mutation

Der Executor führt aus:

```text
docker compose ... run --rm --no-deps -T privacy-check
```

Ein non-zero Exit oder eine Policy-Ausgabe, die den signierten Preflight-Proof nicht erfüllt, führt zu keinem Target-Recreate. Auf Retry muss ein vorhandener Proof wiederverwendet werden. Fehlt er nach bereits sichtbarer Mutation, stoppt der Executor fail-closed.

## Target-Recreate und Crash/Retry

Vor jedem Recreate fragt der Host die #244-State-Machine ab. Nur `READY_TO_RECREATE_TARGET` mit `serviceMutationAllowed=true` erlaubt eine weitere Mutation.

Bereits Target laufende Services werden übersprungen. Ist der vollständige Target-State bereits sichtbar, aber `TARGET_RECREATED` fehlt, wird nur das fehlende Event nachgezogen.

## Health-, Preserve- und Volume-Grenzen

Nach jedem Recreate wird der Container über Compose-Projekt-/Service-Labels neu aufgelöst.

- `app` muss `running` und `healthy` werden,
- Background-Services müssen `running` sein,
- `libsql` und `caddy` bleiben an die Baseline-Identität gebunden,
- vier Anwendungsdaten-Volumes und Caddy Data/Config bleiben unverändert,
- jede nicht beweisbare Lage blockiert weitere Mutation.

## Signierte Live-Runtime-Attestation

Nach vollständigem Target-Recreate erzeugt und prüft der Host die signierte Runtime-Attestation. Auf einem Retry wird ein bereits persistiertes Attestation-Artefakt **nicht neu erzeugt**, sondern gegen frische Inspect-Evidence erneut geprüft. Damit kollidiert ein Crash nach Attestation-Persistenz, aber vor `LIVE_VALIDATED`, nicht mit einem neuen Timestamp.

Target-Prozesse müssen insbesondere `PRIVACY_BACKUP_STATE=ENABLED` mit Policy v1 tragen; `PRIVACY_NOTIFICATIONS_STATE` muss weiterhin `DISABLED` sein. Erst danach folgt `LIVE_VALIDATED`, anschließend `COMPLETED` / `activationExecuted=true`.

## Automatischer Rollback

Ein kontrollierbarer Fehler löst nur bei weiterhin beweisbarer Lage automatischen Rollback aus. Vor jeder Reverse-Mutation wird durable `ROLLBACK_STARTED` geschrieben.

Danach wird die `.env` über den signierten Activation-Plan-v2-Rollback bytegenau auf den ursprünglichen Pre-State zurückgeführt und DISABLED re-attestiert. Nur mutable Services, die noch `ENABLED` sind, werden zurück-recreated; bereits `DISABLED` laufende Services werden nicht unnötig verändert. Nach vollständigem DISABLED-State folgen `ROLLBACK_RECREATED`, signierte DISABLED-Runtime-Attestation und `ROLLBACK_VERIFIED`.

Ein sicherer Rollback endet bei `activationExecuted=false` und `serviceCutoverExecuted=false`.

## Fail-closed statt Blind-Rollback

Wenn Preserve-Identität, Volumes oder Runtime-Zustand nicht mehr beweisbar sind, blockiert der Executor statt blind weiter zu mutieren. Dasselbe gilt, wenn nach einem Prozess-Crash Mutation sichtbar ist, aber der historische signierte Preflight-Proof fehlt.

## Evidence-Verzeichnisse

Journal und Events liegen im privaten #244-Execution-Verzeichnis. Baseline-Verifier-Ausgabe, Inspect-Snapshots, privacy-check-Ausgabe, Preflight-Proof sowie Target-/Rollback-Attestations liegen getrennt außerhalb des append-only Journals. Verzeichnisse werden `0700`, Dateien `0600` angelegt.

## CI-Contract

Der Contract baut zunächst die echte signierte Kette bis #246 mit realem Runner-Docker auf und ersetzt erst danach den Docker-Client durch einen stateful Simulator. Geprüft werden:

- vollständiger Erfolg mit genau einem Target-Recreate je mutable Service,
- `privacy-check` vor dem ersten Recreate,
- niemals `libsql`/`caddy` als Mutationstarget,
- echter Prozessabbruch direkt nach dem ersten Recreate,
- Retry ohne Doppel-Recreate und ohne zweiten Preflight,
- fehlender Proof nach sichtbarer Mutation -> keine weitere Mutation,
- kontrollierter Recreate-Fehler -> sticky Rollback,
- bytegenauer `.env`-Rollback,
- terminal `ROLLBACK_VERIFIED`,
- vollständige Baseline-Docker-Metadaten inklusive `Name`, `StartedAt` und `RestartCount`,
- Post-Baseline-Reobservation vor Journal-Erstellung,
- Wiederverwendung bereits persistierter Runtime-Attestations.

## Noch keine reale Freigabe

Dieser PR beweist den bounded Host-Algorithmus in CI. Er führt **keinen produktiven Host-Cutover** aus und schließt keine praktischen Restore-/RTO-Gates. `.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`.

## Nächster Schritt nach Merge

Nach grünem Merge folgt ein ausdrücklich kontrollierter realer Host-Drill mit echtem Backup/Restore, dokumentiertem RTO und vollständiger Evidence-Kette. Erst ein erfolgreicher praktischer Drill kann die weiterhin offenen TASKS-/Release-Gates begründet schließen.