# Backup Privacy Service Cutover Plan v2

## Zweck

Der produktive Backup-Privacy-Pfad trennt jetzt strikt zwischen **gültiger Target-Konfiguration** und **tatsächlich umgeschalteter Live-Runtime**.

Nach dem atomaren `.env`-Write entsteht auf `main` bereits eine signierte, nichtterminale Target-Handoff-Evidence. Sie beweist den Target-State und dessen statische Policy-Gültigkeit, behauptet aber ausdrücklich noch keine Live-Aktivierung.

Die kanonische Trust Chain lautet:

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> atomic target .env replace
  -> TARGET_HANDOFF_VERIFIED
  -> signed Service-Cutover-Plan v2
  -> [next: signed Live-Baseline]
  -> [then: bounded service recreate]
  -> [then: live-process attestation]
  -> [then: genuine terminal completion / activationExecuted=true]
```

`PRIVACY_BACKUP_STATE=DISABLED` bleibt in der realen Release-Konfiguration unverändert, bis der gesamte operative Pfad einschließlich Live-Cutover und praktischem Drill nachgewiesen ist.

## Warum Service-Cutover-Plan v1 deprecated ist

Der ursprüngliche v1-Plan aus #227 verlangte `activation-execution-completed.json` bereits **vor** dem Service-Cutover. Das ist nach der Live-Runtime-Härtung zirkulär:

- eine ehrliche terminale Completion setzt voraus, dass die laufenden Services tatsächlich mit `ENABLED` neu erzeugt und attestiert wurden,
- genau dieser Service-Cutover sollte aber erst nach der v1-Completion geplant werden.

Der alte `check-backup-privacy-activation-completion.py` blockiert deshalb neue pre-cutover Planungen fail-closed mit:

```text
LIVE_RUNTIME_COMPLETION_REQUIRED
```

Ein historisches oder synthetisches env-only `COMPLETED` darf nicht als Ersatz für Live-Prozessnachweis dienen.

## Kanonischer Eingang: TARGET_HANDOFF_VERIFIED

`check-backup-privacy-target-handoff.py` verifiziert unter anderem:

- Activation Plan v2 und PENDING-Evidence,
- exakten aktuellen Target-`.env`-Fingerprint,
- kanonische Handoff-Datei und deren HMAC/Fingerprint,
- Target-Config-Checker-Pfad und -Dateihash,
- erneute Target-Konfigurations-Attestation,
- Abwesenheit von Rollback- und Legacy-Completion-Konflikten,
- nichtterminale Zustandsflags.

Erst dann gilt:

```text
TARGET_HANDOFF_VERIFIED
serviceCutoverPlanningAllowed=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Service-Cutover-Plan v2

`prepare-backup-privacy-service-cutover-plan-v2.py` konsumiert ausschließlich `TARGET_HANDOFF_VERIFIED` und rendert den Target-Compose-Stack read-only:

```text
docker compose --env-file <target-env> -f <club-compose> config --format json
```

Der Plan bindet:

- Activation- und Execution-ID,
- vollständige Hashes von Activation Plan, PENDING und Target Handoff,
- Target-Handoff-Fingerprint,
- SHA-256 der Target-Configuration-Attestation,
- `.env`-Pfad und Target-Fingerprint,
- Compose-Dateipfad und vollständigen Datei-SHA,
- kanonischen SHA-256 des gerenderten Compose-Modells,
- `privacy-check` als Pflicht-Preflight,
- `app`, `export-cleanup`, `retention-scan` als später zu recreatende Services,
- `libsql` und `caddy` als zu erhaltende Services.

Zentrale Safety-Flags:

```text
targetHandoffRequiredBeforePlanning=true
targetHandoffIsNonterminal=true
preflightMustSucceedBeforeMutation=true
renderedComposeMustRemainBound=true
liveBaselineRequiredBeforeMutation=true
appHealthcheckRequired=true
backgroundServicesRunningRequired=true
liveRuntimeEnvironmentAttestationRequired=true
liveRuntimeCompletionRequiredAfterCutover=true
rollbackOnCutoverFailureRequired=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Der Plan wird unter der separaten Domain

```text
masters:backup-privacy-service-cutover-plan:v2
```

HMAC-signiert und mit `check-backup-privacy-service-cutover-plan-v2.py` unabhängig geprüft.

## Keine Service-Mutation in diesem Slice

Plan v2 führt keine Runtime-Mutation aus. Es gibt hier insbesondere kein:

- `docker inspect` als Live-Baseline-Ersatz,
- `docker compose up/run/restart/stop/down`,
- Volume-Mutation,
- Service-Recreate,
- terminales `activationExecuted=true`.

Das Compose-Rendering beschreibt nur den gewünschten Sollzustand.

## Nächste notwendige Grenze: signierte Live-Baseline

Unmittelbar vor der ersten Service-Mutation muss eine separate signierte Live-Baseline mindestens binden:

- eindeutige aktuelle Container-Identität von `app`, `export-cleanup`, `retention-scan`,
- deren tatsächlich laufende Backup-Privacy-Prozessumgebung als `DISABLED`,
- LibSQL- und Caddy-Container-/Image-Identität,
- tatsächliche Named-Volume-Mounts für LibSQL, Reports, Tenant Exports und Data-Subject Delivery,
- Health-/Running-State,
- exakten Cutover-Plan-v2-Fingerprint.

**Ohne diese Live-Baseline darf keine Service-Mutation stattfinden.**

Erst der spätere bounded Host-Executor darf die drei Runtime-Services recreaten. Danach müssen App-Health, Background-Service-Status und die tatsächlich laufende `ENABLED`-Prozessumgebung attestiert werden. Erst dann darf eine echte terminale Completion `activationExecuted=true` setzen.

Bei jedem Fehler muss vor der Rückmutation durable Rollback-Evidence entstehen; anschließend `.env` bytegenau zurück, betroffene Services mit `DISABLED` recreaten und der laufende DISABLED-State verifizieren.

## CI-Contract

Der `Backup Privacy Service Cutover Plan Contract` beweist serverseitig:

- vollständige bestehende Target-Handoff-Crash/Retry/Rollback-Kette,
- Rebinding an den kanonischen Target-Config-Checker,
- `TARGET_HANDOFF_VERIFIED` als einzige neue Planning-Autorisierung,
- fail-closed Legacy-Completion,
- deterministischen signierten Service-Cutover-Plan v2,
- Target-Handoff- und Plan-Tamper-Blockade,
- `0600`-Planartefakte,
- keine Service-Mutation,
- offene Restore-/RTO-/Release-Gates.
