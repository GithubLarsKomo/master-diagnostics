# Backup Privacy Service Live Baseline v2

## Zweck

Der kanonische Service-Cutover-Plan v2 aus #234 ist durch `TARGET_HANDOFF_VERIFIED` autorisiert und bindet die bereits gestagte Target-Konfiguration. Er verlangt jedoch ausdrücklich `liveBaselineRequiredBeforeMutation=true`.

Die Live-Baseline v2 schließt diese letzte read-only Lücke vor einer Service-Mutation: Sie bindet den tatsächlichen Docker-Istzustand der noch laufenden Club-Services kryptografisch an genau diesen Cutover-Plan.

Der erwartete Übergangszustand ist bewusst zweigeteilt:

```text
staged target .env:     PRIVACY_BACKUP_STATE=ENABLED
currently running app:  PRIVACY_BACKUP_STATE=DISABLED
```

Die gestagte Target-Konfiguration ist also bereits policy-validiert, während die bestehenden Runtime-Prozesse sie noch nicht übernommen haben. Die Baseline beweist diesen Istzustand, ohne daraus vorzeitig eine erfolgreiche Aktivierung abzuleiten.

## Trust Chain

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> atomic target .env replace
  -> signed TARGET_HANDOFF_READY
  -> TARGET_HANDOFF_VERIFIED
  -> signed canonical service cutover plan v2
  -> signed live baseline v2
  -> SERVICE_LIVE_BASELINE_VERIFIED
  -> [nächster Slice: bounded service cutover executor]
  -> [danach: live-process attestation]
  -> [erst dann: terminal activation completion]
```

## Bindung an den kanonischen Cutover-Plan v2

Writer und Checker führen vor jeder Baseline-Operation den kanonischen

```text
check-backup-privacy-service-cutover-plan-v2.py
```

erneut aus. Akzeptiert wird ausschließlich ein Plan mit:

```text
serviceCutoverPlanVersion=2
authorizationSource=TARGET_HANDOFF_VERIFIED
liveBaselineRequiredBeforeMutation=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Damit bleiben Target-Handoff, Target-Environment, Target-Konfigurations-Attestation und Compose-Render Teil jeder Baseline-Prüfung.

## Read-only Docker-Grenze

Der Produktcode verwendet ausschließlich:

- `docker compose ... config --format json`,
- `docker ps -a --no-trunc` mit Compose-Projekt- und Service-Labels,
- `docker inspect`.

Writer und Checker verwenden kein `run`, `create`, `start`, `stop`, `restart`, `rm`, `up`, `down`, keine Docker-Volume-Mutation und keinen `.env`-Replace.

Die Docker-Mutationen im CI-Test dienen ausschließlich dazu, einen synthetischen Pre-Cutover-Istzustand aufzubauen.

## Gebundene Services

Die Baseline verlangt exakt je einen laufenden Compose-Container für:

- `app`,
- `export-cleanup`,
- `retention-scan`,
- `libsql`,
- `caddy`.

One-off-Container sind nicht zulässig. Jeder Container wird über die im signierten Compose-Render enthaltene Projektidentität und die offiziellen Compose-Labels aufgelöst.

Gebunden werden:

- vollständige Container-ID,
- Container-Name,
- Image-ID,
- Image-Referenz,
- Running-/Status-State,
- Health-State, soweit vorhanden,
- `StartedAt`,
- `RestartCount`.

`app` und `libsql` müssen `healthy` sein. `export-cleanup`, `retention-scan` und `caddy` müssen mindestens `running` sein.

Durch `StartedAt` und `RestartCount` wird auch ein Restart desselben Containers bei unveränderter Container-ID als Drift erkannt.

## Tatsächlicher Privacy-State der laufenden Prozesse

Für die später zu recreatenden Runtime-Services

- `app`,
- `export-cleanup`,
- `retention-scan`

werden ausschließlich die zehn bekannten `PRIVACY_*`-Variablen aus `docker inspect -> Config.Env` übernommen.

Vor dem Cutover müssen diese bereits laufenden Prozesse weiterhin mindestens tragen:

```text
PRIVACY_BACKUP_STATE=DISABLED
PRIVACY_NOTIFICATIONS_STATE=DISABLED
```

Andere Environment-Variablen werden weder übernommen noch gehasht oder in das Evidence-Artefakt geschrieben. Auth-, Datenbank- und sonstige Secrets bleiben damit außerhalb der Live-Baseline.

Die Target-`.env` ist zu diesem Zeitpunkt bereits `ENABLED`; die Baseline verwechselt die gestagte Konfiguration ausdrücklich nicht mit dem tatsächlichen Live-Prozesszustand.

## Persistente Named Volumes

Die vorhandene aktive Volume-Auflösung wird gegen denselben signierten Compose-Render wiederverwendet. Gebunden werden die Anwendungsdaten-Volumes für:

- LibSQL,
- Reports,
- Tenant Exports,
- Data-Subject Delivery.

Zusätzlich werden die beiden persistenten Caddy-Volumes gebunden:

- Caddy Data,
- Caddy Config.

Damit kann ein späterer Executor nach jeder Mutation prüfen, dass persistente Datenrollen weiterhin auf denselben Named Volumes liegen.

## Signierte Evidence v2

Der Writer persistiert unter einem privaten Output-Root (`0700`) eine Datei

```text
baseline-<32 hex>.json
```

mit Dateirechten `0600`.

Die HMAC-Domain lautet:

```text
masters:backup-privacy-service-live-baseline:v2
```

Die Baseline bindet insbesondere:

- Cutover-ID,
- Cutover-Planversion 2,
- Cutover-Plan-Fingerprint,
- SHA-256 des vollständigen Cutover-Plan-Artefakts,
- `authorizationSource=TARGET_HANDOFF_VERIFIED`,
- Target-Handoff-Fingerprint,
- Activation-ID,
- SHA-256 des signierten Compose-Renders,
- Compose-Projektname,
- fünf Container-Snapshots,
- sechs Named-Volume-Rollen,
- `liveStateFingerprint`,
- `baselineFingerprint`.

Der Evidence-State bleibt strikt pre-mutation:

```text
targetConfigurationAlreadyStaged=true
cutoverMutationStarted=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Deterministische Identität und Retry

Die Baseline-ID wird deterministisch aus

- `cutoverPlanFingerprint` und
- `liveStateFingerprint`

abgeleitet. Ein erneuter Writer-Lauf bei unverändertem Docker-Istzustand verwendet dasselbe signierte Artefakt wieder.

`capturedAt` dokumentiert die erste persistierte Beobachtung, ist aber nicht Teil der Zustandsidentität.

## Unabhängige Live-Re-Attestation

`check-backup-privacy-service-live-baseline.py` verifiziert zunächst erneut die komplette Cutover-v2-/Handoff-Kette sowie Baseline-HMAC und -Fingerprints. Danach wird der aktuelle Docker-Zustand erneut live erfasst.

Nur wenn Container, Images, Startzeiten, Restart-Zähler, Health, Privacy-State und Named Volumes exakt mit der signierten Baseline übereinstimmen, gilt:

```text
SERVICE_LIVE_BASELINE_VERIFIED
serviceCutoverExecutionAllowed=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Diese Freigabe autorisiert ausschließlich den nächsten bounded Service-Cutover-Slice. Sie ist keine Target-Live-Attestation und keine terminale Aktivierung.

Jeder Container-Recreate, Restart, Health-Verlust, doppelte Service-Identität, Privacy-State-Wechsel oder Volume-Drift blockiert fail-closed.

## CI-Contract

Der Contract baut zunächst die vollständige kanonische #234-Kette bis zum Service-Cutover-Plan v2 auf und erzeugt danach echte kurzlebige Docker-Fixtures für den Pre-Cutover-Istzustand.

Geprüft werden:

- gestagte Target-`.env` `ENABLED` bei gleichzeitig laufenden Runtime-Containern `DISABLED`,
- erfolgreiche v2-Baseline-Erfassung,
- `0700`/`0600`-Evidence-Rechte,
- Abwesenheit eines bewusst gesetzten Nicht-Privacy-Secrets im Artefakt,
- vollständige v2-Cutover-/Handoff-Bindung,
- unabhängige Live-Re-Attestation,
- deterministische Wiederverwendung,
- Blockade bei doppelter Service-Identität,
- HMAC-/Fingerprint-Tampering,
- Restart-Drift bei unveränderter Container-ID,
- ausschließlich read-only Docker-Befehle im Produktcode.

## Nächster Slice

Der nächste sichere Schritt ist der **bounded Service-Cutover-Executor**. Er muss unmittelbar vor jeder ersten Mutation Target-Handoff, Cutover-Plan v2 und Live-Baseline erneut verifizieren und danach mindestens:

1. durable `CUTOVER_STARTED`-Evidence vor der ersten Docker-Mutation persistieren,
2. den Target-Privacy-Preflight ausführen,
3. ausschließlich `app`, `export-cleanup` und `retention-scan` recreaten,
4. `libsql` und `caddy` auf ihrer signierten Baseline-Identität halten,
5. Named-Volume-Invarianten nach den Recreates prüfen,
6. App-Health und Background-Running-State prüfen,
7. die tatsächliche Prozessumgebung der neuen Runtime-Container als `ENABLED` attestieren,
8. erst danach terminale Activation-Completion mit `activationExecuted=true` erzeugen.

Bei jedem Fehler muss vor der Rückmutation durable Rollback-Evidence entstehen. Die `.env` ist anschließend bytegenau auf den signierten `DISABLED`-Pre-State zurückzuführen und der Runtime-Stack kontrolliert in einen verifizierten sicheren Zustand zu recreaten.

`.env.example` bleibt `PRIVACY_BACKUP_STATE=DISABLED`. Die realen Restore-/RTO- und Release-Gates bleiben bis zum praktischen Host-Nachweis offen.
