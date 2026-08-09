# Backup Privacy Service Cutover Plan v2

## Zweck

Service Cutover Plan v2 ersetzt die produktive Autorisierungsquelle des historischen #227-v1-Plans.

v1 war an ein terminales #226-`COMPLETED` gebunden. Nach der in #229/#231 gehärteten Trust-Boundary ist das für den produktiven Pfad zu früh: Vor dem echten Live-Service-Cutover darf `activationExecuted=true` noch nicht behauptet werden.

v2 konsumiert deshalb ausschließlich:

```text
TARGET_HANDOFF_VERIFIED
```

und bleibt selbst strikt read-only und nichtterminal.

## Autorisierungskette

```text
signed reversible Activation Plan v2
  -> signed #225 PENDING execution
  -> signed #231 TARGET_HANDOFF_READY
  -> independent TARGET_HANDOFF_VERIFIED
  -> signed Service Cutover Plan v2
  -> next: signed Live Baseline
```

Der Handoff-Checker re-attestiert vor jeder Planung die aktuelle Target-Konfiguration, ihren Checker-Dateihash, die Handoff-HMAC und den exakten Target-Env-Fingerprint.

Ein synthetisches oder historisches terminales #226-`COMPLETED` ist keine alternative v2-Autorisierung.

## Service Cutover Plan v2

Neue HMAC-Domain:

```text
masters:backup-privacy-service-cutover-plan:v2
```

Der Plan bindet:

- `activationId`,
- `executionId`,
- Activation-Plan-Pfad und vollständigen SHA-256,
- PENDING-Pfad und vollständigen SHA-256,
- `targetHandoffPath`,
- Handoff-Fingerprint und vollständigen Handoff-Dateihash,
- SHA-256 der Target-Konfigurations-Attestation,
- gebundenen Target-Env-Fingerprint,
- Compose-Dateipfad und -SHA,
- kanonischen SHA-256 des gerenderten Target-Compose,
- `privacy-check` als Preflight-Service,
- exakt `app`, `export-cleanup`, `retention-scan` als spätere Recreate-Menge,
- exakt `libsql`, `caddy` als zu erhaltende Services,
- die fünf Backup-Privacy-Targetwerte.

Feste v2-Sicherheitsflags:

```text
authorizationSource=TARGET_HANDOFF_VERIFIED
targetHandoffRequiredBeforePlanning=true
terminalActivationEvidenceForbiddenBeforeLiveCutover=true
preflightMustSucceedBeforeMutation=true
renderedComposeMustRemainBound=true
caddyContainerMustBePreserved=true
libsqlContainerMustBePreserved=true
appHealthcheckRequired=true
backgroundServicesRunningRequired=true
liveRuntimeEnvironmentAttestationRequired=true
liveBaselineRequiredBeforeMutation=true
rollbackOnCutoverFailureRequired=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Damit ist ein verifizierter v2-Plan **noch keine** Erlaubnis, sofort Docker zu mutieren. Vor der ersten Service-Mutation muss zusätzlich eine signierte Live-Baseline existieren.

## Compose-Validierung

Der Planner darf Docker Compose nur read-only rendern:

```text
docker compose --env-file <target-env> -f <club-compose> config --format json
```

Er prüft im Render:

- `privacy-check`, `app`, `export-cleanup`, `retention-scan`, `libsql`, `caddy` sind vorhanden,
- `privacy-check` und alle drei später zu recreatenden Services sehen die fünf vollständigen Backup-Privacy-Targetwerte,
- `privacy-check` führt den Capability-Check aus,
- `app` wartet auf erfolgreichen `privacy-check`.

Der vollständige Render wird kanonisch gehasht und im Plan gebunden.

## Determinismus und Drift

Der `cutoverId` wird aus den unveränderlichen Handoff-/Plan-/Compose-Bindungen abgeleitet. Identische Planung verwendet dieselbe signierte Datei erneut.

Der read-only v2-Verifier führt vor Freigabe erneut aus:

1. `TARGET_HANDOFF_VERIFIED`,
2. SHA-Prüfung von Plan/PENDING/Handoff/Compose,
3. erneutes Compose-Rendering,
4. Plan-Fingerprint und HMAC,
5. alle v2-Safety-Flags.

Änderungen an Handoff, Target-Env, Compose oder Plan blockieren fail-closed.

## Verhältnis zu v1

Die v1-Dateien aus #227 bleiben als historische, bereits getestete Evidence-Implementierung im Repository. Der neue produktive Folgepfad soll jedoch nur v2 konsumieren.

Das verhindert ein stilles Uminterpretieren älterer signierter v1-Pläne und macht die Trust-Chain explizit versioniert.

## CI-Vertrag

Der v2-Contract beginnt mit der echten #231-Target-Handoff-Kette und prüft:

- `TARGET_HANDOFF_VERIFIED`,
- Target-Compose-Policy,
- v2-Fingerprint/HMAC,
- `authorizationSource=TARGET_HANDOFF_VERIFIED`,
- `activationExecuted=false`,
- `liveBaselineRequiredBeforeMutation=true`,
- deterministischen Retry,
- Handoff-Tampering,
- Compose-Dateidrift,
- Plan-Version/Fingerprint-Tampering,
- vollständige Abwesenheit von `up/run/restart/stop/down`, Volume-Mutation und `os.replace`.

## Nächster Slice

Der nächste sichere Slice ist die signierte **Service Live Baseline**.

Sie muss unmittelbar vor der ersten Docker-Mutation den Ist-Zustand gegen einen verifizierten v2-Plan binden, insbesondere:

- aktuelle Container-IDs und Images von `app`, `export-cleanup`, `retention-scan`,
- deren tatsächlich laufenden Backup-State `DISABLED`,
- `libsql` und Caddy als preserved Container-/Image-IDs,
- aktive Named-Volume-Mounts für LibSQL, Reports, Tenant Exports und Data-Subject Delivery,
- Running-/Health-State,
- Compose-Projekt,
- v2-Cutover-Plan-Fingerprint.

Ohne diese Baseline darf der spätere Service-Recreate-Executor nicht mutieren.

`.env.example` bleibt DISABLED; praktische Restore-/RTO- und Release-Gates bleiben offen.
