# Backup Privacy Service Live Baseline v2

## Zweck

Der Service-Cutover-Plan v2 beschreibt den signierten Target-Sollzustand, erteilt aber bewusst noch keine Ausführungsfreigabe. Vor der ersten Container-Mutation muss zusätzlich feststehen, **welcher reale Docker-Istzustand** als Pre-Cutover- und Rollback-Baseline gilt.

Die Live-Baseline v2 persistiert diesen Istzustand HMAC-signiert und re-attestierbar. Writer und Checker selbst führen keine Docker-Mutation aus.

## Trust Chain

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> atomic target .env replace
  -> signed TARGET_HANDOFF_READY
  -> signed service cutover plan v2
  -> signed live baseline v2
  -> SERVICE_LIVE_BASELINE_VERIFIED
  -> [nächster Slice: bounded service cutover executor]
```

Wichtig ist der Übergangszustand:

```text
staged target .env:     PRIVACY_BACKUP_STATE=ENABLED
currently running app:  PRIVACY_BACKUP_STATE=DISABLED
```

Genau diese Differenz ist vor dem Recreate erwartet und wird durch die Baseline beweisbar gemacht.

## Read-only Docker-Grenze

Produktcode verwendet ausschließlich:

- `docker compose ... config --format json`,
- `docker ps -a --no-trunc` mit Compose-Projekt-/Service-Labels,
- `docker inspect`.

Es gibt in Writer/Checker kein `run`, `create`, `start`, `stop`, `restart`, `rm`, `up`, `down`, keine Volume-Mutation und keinen `.env`-Replace.

## V2-Cutover-Bindung

Vor jeder Baseline-Erfassung und jeder Baseline-Prüfung wird `check-backup-privacy-service-cutover-plan.py` erneut ausgeführt. Akzeptiert wird ausschließlich:

```text
serviceCutoverPlanVersion=2
status=SERVICE_CUTOVER_PLAN_VERIFIED
liveBaselineRequired=true
serviceCutoverExecutionAllowed=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Damit bleiben Target-Handoff, Target-Konfigurations-Attestation, Target-`.env` und Compose-Render Teil jeder Live-Baseline-Prüfung.

## Gebundene Container

Die Baseline verlangt exakt je einen laufenden Container für:

- `app`,
- `export-cleanup`,
- `retention-scan`,
- `libsql`,
- `caddy`.

Aufgelöst wird ausschließlich über die im signierten Compose-Render enthaltene Projektidentität und die offiziellen Compose-Labels. One-off-Container sind ausgeschlossen.

Gebunden werden pro Container:

- vollständige Container-ID,
- Container-Name,
- Image-ID,
- Image-Referenz,
- Running-/Status-State,
- Health-State, soweit vorhanden,
- `StartedAt`,
- `RestartCount`.

`app` und `libsql` müssen `healthy` sein. Die Background-Services und Caddy müssen mindestens `running` sein.

`StartedAt` plus `RestartCount` sorgen dafür, dass auch ein Restart desselben Containers bei unveränderter Container-ID die Baseline ungültig macht.

## Tatsächlicher Pre-Cutover-Privacy-State

Für die später zu recreatenden Runtime-Services

- `app`,
- `export-cleanup`,
- `retention-scan`

werden ausschließlich die zehn bekannten `PRIVACY_*`-Variablen aus `docker inspect -> Config.Env` übernommen.

Vor dem Cutover müssen die **laufenden** Prozesse weiterhin tragen:

```text
PRIVACY_BACKUP_STATE=DISABLED
PRIVACY_NOTIFICATIONS_STATE=DISABLED
```

Andere Environment-Variablen werden weder in die Evidence kopiert noch gehasht. Auth-, Datenbank- und sonstige Secrets bleiben außerhalb der Baseline.

Die Target-`.env` ist zu diesem Zeitpunkt bereits über `TARGET_HANDOFF_VERIFIED` als `ENABLED` gebunden. Die Baseline verwechselt diese staged Konfiguration ausdrücklich nicht mit dem Live-Prozesszustand.

## Named-Volume-Invarianten

Die bestehende aktive Volume-Auflösung wird gegen denselben signierten Compose-Render verwendet. Gebunden werden:

- LibSQL,
- Reports,
- Tenant Exports,
- Data-Subject Delivery,
- Caddy Data,
- Caddy Config.

Damit kann ein späterer Recreate-Executor prüfen, dass persistente Datenrollen vor und nach jeder Mutation auf denselben Named Volumes liegen.

## Evidence v2

Der Writer persistiert unter einem privaten Output-Root (`0700`):

```text
baseline-<32 hex>.json
```

mit Dateirechten `0600`.

Neue HMAC-Domain:

```text
masters:backup-privacy-service-live-baseline:v2
```

Die Baseline bindet insbesondere:

- Cutover-ID und Cutover-Planversion 2,
- Cutover-Plan-Fingerprint und vollständigen Datei-SHA,
- Target-Handoff-Fingerprint,
- Activation-ID,
- signierten Compose-Render-SHA,
- Compose-Projektname,
- fünf Container-Snapshots,
- sechs Named-Volume-Rollen,
- `liveStateFingerprint`,
- `baselineFingerprint`.

Der Zustand bleibt strikt pre-mutation:

```text
targetConfigurationAlreadyStaged=true
cutoverMutationStarted=false
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

## Deterministische Identität

Die Baseline-ID ist deterministisch aus

- `cutoverPlanFingerprint` und
- `liveStateFingerprint`

abgeleitet. Ein erneuter Writer-Lauf bei unverändertem Docker-Istzustand verwendet dieselbe signierte Evidence wieder.

`capturedAt` dokumentiert die erste persistierte Beobachtung und verändert die Zustandsidentität nicht.

## Unabhängige Live-Re-Attestation

`check-backup-privacy-service-live-baseline.py` verifiziert zunächst erneut die komplette v2-Cutover-Kette sowie HMAC und Baseline-Fingerprints. Anschließend wird **der aktuelle Docker-Zustand erneut live erfasst**.

Nur wenn Container, Images, Startzeiten, Restart-Zähler, Health, Privacy-State und Volumes exakt der signierten Baseline entsprechen, gilt:

```text
SERVICE_LIVE_BASELINE_VERIFIED
serviceCutoverExecutionAllowed=true
serviceCutoverExecuted=false
liveRuntimeAttested=false
activationExecuted=false
```

Diese Freigabe erlaubt lediglich den nächsten bounded Cutover-Slice. Sie ist weiterhin keine Live-Target-Attestation und keine terminale Aktivierung.

Jeder Container-Recreate, Restart, Health-Verlust, doppelte Service-Identität, Privacy-State-Wechsel oder Volume-Drift blockiert fail-closed.

## CI-Contract

Der Contract baut die vollständige korrigierte Trust Chain bis zum Service-Cutover-Plan v2 auf. Anschließend erzeugt der **Testcode** echte kurzlebige Docker-Container und Named Volumes als synthetischen Pre-Cutover-Istzustand.

Geprüft werden:

- staged Target-`.env = ENABLED` bei gleichzeitig laufenden Runtime-Containern `DISABLED`,
- erfolgreiche v2-Baseline-Erfassung,
- `0700`/`0600`-Evidence-Rechte,
- Abwesenheit eines bewusst gesetzten Nicht-Privacy-Secrets,
- vollständige v2-Cutover-/Handoff-Bindung,
- unabhängige Live-Re-Attestation,
- deterministische Wiederverwendung,
- Blockade bei doppelter Service-Identität,
- HMAC-/Fingerprint-Tampering,
- Restart-Drift bei unveränderter Container-ID,
- ausschließlich read-only Docker-Befehle im Produktcode.

Die Docker-Mutationen im Testskript dienen nur zum Aufbau synthetischer Fixtures; Writer und Checker bleiben read-only.

## Nächster Slice

Der nächste sichere Schritt ist der **bounded Service-Cutover-Executor**. Er muss unmittelbar vor jeder Mutation Target-Handoff, Cutover-Plan v2 und Live-Baseline erneut prüfen, dann:

1. Target-`privacy-check` erfolgreich ausführen,
2. durable `CUTOVER_STARTED`-Evidence persistieren,
3. ausschließlich `app`, `export-cleanup` und `retention-scan` recreaten,
4. `libsql` und `caddy` exakt auf ihrer Baseline-Identität halten,
5. Named-Volume-Invarianten nach jedem Recreate prüfen,
6. App-Health und Background-Running-State prüfen,
7. die tatsächliche Prozessumgebung der neuen Runtime-Container als `ENABLED` attestieren,
8. erst danach terminale Activation-Completion mit `activationExecuted=true` erzeugen.

Bei jedem Fehler muss vor der Rückmutation durable Rollback-Evidence entstehen. Die `.env` ist anschließend bytegenau auf den signierten DISABLED-Pre-State zurückzuführen und der Runtime-Stack kontrolliert auf den Baseline-Zustand zurückzubringen.

`.env.example` und die realen Restore-/RTO-/Release-Gates bleiben bis zum praktischen Host-Nachweis offen.
