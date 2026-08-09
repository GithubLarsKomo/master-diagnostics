# Backup Privacy Service Live Baseline v1

## Zweck

Der signierte Service-Cutover-Plan aus #227 beschreibt den Target-Sollzustand. Unmittelbar vor der ersten Container-Mutation muss zusätzlich feststehen, **welcher reale Docker-Istzustand** als Rollback- und Crash-Recovery-Baseline gilt.

Dieser Slice persistiert deshalb eine HMAC-signierte Live-Baseline. Er führt selbst **keine Service-Mutation** aus.

Die Trust Chain wird damit:

```text
signed activation plan v2
  -> signed PENDING execution evidence
  -> signed env-activation COMPLETED evidence
  -> signed service cutover plan v1
  -> signed live baseline v1
  -> [nächster Slice: bounded service cutover executor]
```

## Read-only Docker-Grenze

Writer und Checker verwenden ausschließlich:

- `docker compose ... config --format json`,
- `docker ps -a --no-trunc` mit Compose-Labels,
- `docker inspect`.

Es gibt kein `run`, `create`, `start`, `stop`, `restart`, `rm`, `up`, `down`, keine Volume-Mutation und keinen Filesystem-Replacement-Write außerhalb des Evidence-Artefakts.

## Gebundene Container

Die Live-Baseline verlangt exakt je einen laufenden Container für:

- `app`,
- `export-cleanup`,
- `retention-scan`,
- `libsql`,
- `caddy`.

Die Container werden ausschließlich über die im signierten Compose-Render enthaltene Projektidentität und die offiziellen Compose-Labels aufgelöst. One-off-Container sind nicht zulässig.

Für jeden Container werden gebunden:

- vollständige Container-ID,
- Container-Name,
- Image-ID,
- Image-Referenz,
- Running-/Status-State,
- Health-State, soweit vorhanden,
- `StartedAt`,
- `RestartCount`.

`app` und `libsql` müssen `healthy` sein. Die Background-Services und Caddy müssen mindestens `running` sein.

Durch `StartedAt` plus `RestartCount` wird auch ein Restart desselben Containers ohne Änderung seiner Container-ID als Baseline-Drift erkannt.

## Live-Privacy-State

Für die drei später zu recreatenden Runtime-Services

- `app`,
- `export-cleanup`,
- `retention-scan`

werden ausschließlich die zehn bekannten `PRIVACY_*`-Variablen aus `Config.Env` extrahiert.

Vor dem Service-Cutover müssen alle drei Prozesse weiterhin mindestens tragen:

```text
PRIVACY_BACKUP_STATE=DISABLED
PRIVACY_NOTIFICATIONS_STATE=DISABLED
```

Andere Environment-Variablen werden weder übernommen noch gehasht oder in das Artefakt geschrieben. Insbesondere werden Auth-, Datenbank- oder sonstige Secrets nicht in die Live-Baseline kopiert.

## Named-Volume-Invarianten

Die vorhandene aktive Volume-Auflösung wird gegen den signierten Compose-Render wiederverwendet. Gebunden werden die vier Anwendungsdaten-Volumes:

- LibSQL,
- Reports,
- Tenant Exports,
- Data-Subject Delivery.

Zusätzlich werden die beiden Named Volumes des zu erhaltenden Caddy-Containers gebunden:

- Caddy Data,
- Caddy Config.

Damit kann ein späterer Executor nach jedem Recreate prüfen, dass die persistenten Datenrollen weiterhin auf denselben Docker-Volumes liegen.

## Evidence

Der Writer persistiert unter einem privaten Output-Root (`0700`) eine Datei

```text
baseline-<32 hex>.json
```

mit `0600`.

Die HMAC-Domain lautet:

```text
masters:backup-privacy-service-live-baseline:v1
```

Die Baseline bindet insbesondere:

- Cutover-ID und Cutover-Plan-Fingerprint,
- SHA-256 des vollständigen Cutover-Plan-Artefakts,
- Activation-ID,
- SHA-256 des signierten Compose-Renders,
- Compose-Projektname,
- die fünf Container-Snapshots,
- die sechs Named-Volume-Rollen,
- `liveStateFingerprint`,
- `baselineFingerprint`.

Die Baseline-ID ist deterministisch aus Cutover-Plan-Fingerprint und Live-State-Fingerprint abgeleitet. Ein Retry bei unverändertem Live-State verwendet dasselbe signierte Artefakt wieder.

Die Evidence bleibt strikt pre-mutation:

```text
cutoverMutationStarted=false
serviceCutoverExecuted=false
liveTargetAttested=false
```

## Unabhängige Re-Attestation

`check-backup-privacy-service-live-baseline.py` verifiziert zunächst erneut die komplette Cutover-Plan-Kette und anschließend:

- Dateipfad und Baseline-ID,
- Cutover-/Activation-Bindung,
- Live-State- und Baseline-Fingerprint,
- HMAC,
- Pre-Cutover-State `DISABLED`,
- alle pre-mutation Flags.

Danach wird **der aktuelle Docker-Zustand erneut live erfasst**. Nur wenn Container, Startzeit, Restart-Zähler, Images, Privacy-State, Health und Volumes exakt mit der signierten Baseline übereinstimmen, entsteht:

```text
SERVICE_LIVE_BASELINE_VERIFIED
serviceCutoverExecutionAllowed=true
```

Jeder Restart, Container-Recreate, Health-Verlust, Service-Duplikat, Privacy-State-Wechsel oder Volume-Drift macht die Baseline ungültig.

## CI-Contract

Der Contract verwendet die vollständige synthetische signierte #220 -> #227 Kette und startet zusätzlich echte kurzlebige Docker-Container mit Compose-Labels und Named Volumes. Er prüft:

- erfolgreiche Live-Baseline-Erfassung,
- `0700`/`0600`-Evidence-Rechte,
- Abwesenheit eines bewusst gesetzten Nicht-Privacy-Secrets im Artefakt,
- unabhängige Live-Re-Attestation,
- deterministische Wiederverwendung,
- Blockade bei doppelter Service-Identität,
- Fingerprint-/HMAC-Tampering,
- Restart-Drift bei unveränderter Container-ID,
- ausschließlich read-only Docker-Befehle im Produktcode.

Die Docker-Mutationen des CI-Tests dienen ausschließlich dazu, synthetische Istzustände aufzubauen; Writer und Checker selbst bleiben read-only.

## Nächster Slice

Nach erfolgreicher Live-Baseline ist der nächste sichere Schritt der **bounded Service-Cutover-Executor**. Er muss Plan + Baseline unmittelbar vor jeder Mutation erneut verifizieren, `privacy-check` als Target-Preflight ausführen, durable `CUTOVER_STARTED`-Evidence schreiben und nur `app`, `export-cleanup` und `retention-scan` recreaten.

`libsql` und `caddy` müssen dabei ihre signierte Baseline-Identität behalten. Bei jedem Fehler muss vor der Rückmutation durable Rollback-Evidence entstehen; anschließend muss die `.env` über den signierten Activation-Plan-v2 auf den exakten DISABLED-Bytestring zurückgeführt und der Runtime-Stack kontrolliert in den Baseline-State recreatet werden.

Die realen Restore-/RTO- und Release-Gates bleiben auch nach diesem Slice offen, bis dieser Pfad auf dem vorgesehenen Host praktisch nachgewiesen ist.
