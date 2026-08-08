# Private Restore Promotion Execution Plan

## Zweck

Der Promotion Execution Plan ist die letzte durable Planungsschicht **vor** einer späteren Docker-/Produktivmutation. Er entsteht nur aus einem unmittelbar grünen Promotion Execution Preflight und bindet diesen an die tatsächlich aktuell verwendeten Produktions-Volumes.

Der Plan selbst führt keine Mutation aus:

```text
productionMutationAllowed = false
promotionExecuted = false
```

## Warum keine In-place-Wiederherstellung

Der Club-Stack verwendet getrennte persistente Datenbereiche für:

- libSQL,
- Reports,
- Tenant-Exports,
- Betroffenenexporte.

Ein direktes Überschreiben dieser vier laufenden Volumes hätte keine gemeinsame atomare Grenze. Ein Fehler nach dem Kopieren einzelner Datenbereiche könnte einen gemischten Produktivzustand erzeugen und gleichzeitig den vorherigen Zustand zerstören.

Deshalb verwendet die Promotion-Architektur **versionierte neue Kandidaten-Volumes**. Die aktuell aktiven Volumes werden nicht überschrieben und bilden den Rollback-Satz.

## Gebundene Datenrollen

Execution Plan v1 enthält exakt vier Rollen in kanonischer Reihenfolge:

1. `LIBSQL` → privater Workspace `libsql`
2. `REPORTS` → privater Workspace `reports`
3. `TENANT_EXPORTS` → privater Workspace `tenant-exports`
4. `DATA_SUBJECT_DELIVERY` → privater Workspace `data-subject-delivery`

Für jede Rolle werden gebunden:

- `activeVolumeName`
- `candidateVolumeName`
- `rollbackVolumeName`
- fester `restoreWorkspaceSubpath`

`rollbackVolumeName` muss exakt `activeVolumeName` entsprechen.

## Read-only Host-Auflösung

Der Plan-Core kennt keine Compose-Projektpräfixe und errät keine produktiven Docker-Volume-Namen.

Der Host-Resolver

```text
infra/backup/resolve-active-club-volumes.py
```

vergleicht zwei unabhängige technische Quellen:

1. `docker compose config --format json` des aktuellen Club-Stacks,
2. `docker inspect` der tatsächlich laufenden `app`- und `libsql`-Container.

Für jede der vier Datenrollen muss im gerenderten Compose genau ein Named-Volume-Mount am erwarteten Ziel existieren. Im laufenden Container muss genau ein beschreibbarer Docker-Volume-Mount am selben Ziel existieren.

Zusätzlich werden geprüft:

- `com.docker.compose.service` des laufenden Containers,
- `com.docker.compose.project`, sofern der gerenderte Compose-Name vorhanden ist,
- Top-Level-Deklaration des logischen Compose-Volumes,
- optionaler expliziter Compose-Volume-Name,
- eingeschränktes Docker-Volume-Namensformat,
- Eindeutigkeit aller vier logischen Rollen,
- Eindeutigkeit aller vier tatsächlich aktiven Docker-Volumes.

Der Resolver führt ausschließlich Leseoperationen aus. Er erstellt, löscht oder mountet kein Docker-Volume.

### Warum gerenderter und laufender Zustand gemeinsam geprüft werden

Nur `docker compose config` würde lediglich den Sollzustand beschreiben. Nur `docker inspect` würde zwar den Istzustand zeigen, aber nicht beweisen, dass die Mount-Ziele noch dem aktuellen Club-Vertrag entsprechen.

Die Kombination verhindert insbesondere, dass ein veralteter oder fremder Container-Mount unbemerkt als Rollback-Basis in den Execution Plan eingeht.

## Host-Befehl

Die Plan-Erstellung ist ein eigener expliziter Schritt:

```bash
bash infra/backup/prepare-club-restore-promotion-plan.sh restore-<timestamp>-<uuid>
```

Der Wrapper:

1. validiert Staging-Name und private Restore-Pfade,
2. verlangt bereits vorhandenes `promotion-intent.json`,
3. prüft Artifact- und optionale Recovery-Evidence auf sichere Pfade,
4. rendert den aktuellen Club-Compose-Stack read-only,
5. verlangt genau einen laufenden `app`- und `libsql`-Container,
6. liest deren Mounts mit `docker inspect`,
7. lässt die vier aktiven Docker-Volume-Namen durch den Resolver validieren,
8. startet ausschließlich die private Restore-DB und deren idempotente Migration,
9. übergibt die vier validierten Volume-Namen als Environment-Werte an den isolierten Plan-Service.

Der Wrapper enthält ausdrücklich keine Befehle für:

- `docker volume create`,
- `docker volume rm`,
- `docker cp`,
- produktive `docker compose down`-/Switch-Operationen,
- erneuten DB-/Artifact-Replay,
- erneute Recovery-Ausführung.

## Plan-CLI

Container-Einstiegspunkt:

```bash
pnpm --filter @masters/db backup:restore-promotion-plan
```

Der CLI akzeptiert keinen gespeicherten Preflight als Autorisierungsquelle. Er:

1. rekonstruiert Promotion Readiness erneut aus aktueller Raw Evidence,
2. verifiziert den signierten Promotion Intent erneut,
3. berechnet dadurch einen frischen Promotion Execution Preflight,
4. validiert die vier hostseitig aufgelösten aktiven Docker-Volume-Namen,
5. persistiert erst dann den signierten Execution Plan.

Bei Erfolg bleibt die Sicherheitsgrenze ausdrücklich:

```text
status = PREPARED
promotionAllowed = true
authorizationPersisted = true
productionMutationAllowed = false
promotionExecuted = false
evidenceRecomputed = true
```

Der Output enthält außerdem:

- `executionFingerprint`,
- `planFingerprint`,
- `planSignature`,
- `candidateSetId`,
- `activeVolumeSetFingerprint`,
- `caddyPolicy`,
- alle vier gebundenen Volume-Rollen.

Ein identischer Retry reused den bestehenden Plan. Ändert sich nur ein aktiver Volume-Name, wird der vorhandene Plan nicht ersetzt oder angepasst, sondern fail-closed abgelehnt.

## Isolierter Plan-Service

`infra/docker-compose.restore-promotion.yml` enthält zusätzlich:

```text
backup-restore-promotion-plan
```

Der Service:

- nutzt nur `backup-privacy-replay-db`,
- läuft nur auf `restore-internal`,
- sieht den gesamten privaten Restore-Workspace read-only,
- darf ausschließlich `/restore-replay/promotion` schreiben,
- liest Promotion-Key, Ledger und Journal nur read-only,
- erhält keinen Docker-Socket,
- erhält keine produktiven Named Volumes,
- erhält die vier aktiven Namen nur als bereits hostseitig validierte Environment-Werte.

Damit kann der Container zwar den signierten Plan erzeugen, aber weder Docker selbst steuern noch produktive Daten verändern.

## Deterministische Kandidaten

Aus dem unmittelbar grünen `preflight.executionFingerprint` werden die ersten 20 Hex-Zeichen als technischer Kandidaten-Satz verwendet:

```text
candidateSetId = restore-<20hex>
```

Daraus entstehen ausschließlich neue explizite Docker-Volume-Namen:

```text
master-diagnostics-restore-<20hex>-libsql
master-diagnostics-restore-<20hex>-reports
master-diagnostics-restore-<20hex>-tenant-exports
master-diagnostics-restore-<20hex>-data-subject-delivery
```

Kandidaten müssen:

- untereinander eindeutig sein,
- von allen aktiven Volumes verschieden sein,
- dem eingeschränkten Docker-Volume-Namensformat entsprechen.

## Rollback-Vertrag

```text
rollbackStrategy = KEEP_PREVIOUS_ACTIVE_VOLUMES
```

Das bedeutet:

- bisherige Produktions-Volumes werden nicht gelöscht,
- sie werden nicht als Kopierziel verwendet,
- sie werden nicht vor erfolgreichem Kandidaten-Healthcheck verändert,
- ein späterer Switch muss sie als unveränderten Rücksprungpunkt behandeln.

Der Rollback ist damit eine Selector-/Volume-Satz-Umschaltung, kein Restore-in-place.

## Caddy

Caddy-TLS-/Runtime-State wird bewusst nicht auf den Backup-Zeitpunkt zurückgesetzt:

```text
caddyPolicy = PRESERVE_CURRENT
```

Eine Promotion der privaten Restore-Kopie darf nicht nebenbei ältere Zertifikats-/Caddy-Daten aktivieren.

## Bindung an die Promotion-Evidence

Der Plan bindet:

- Backup-Cutoff,
- Preflight-Version,
- `preflightExecutionFingerprint`,
- `readinessEvidenceFingerprint`,
- Promotion-Intent-Signatur,
- ursprünglichen `authorizedAt`,
- `activeVolumeSetFingerprint`,
- Kandidaten-Satz,
- Safety-Policies,
- `planFingerprint`.

Vor der späteren Mutation muss der Executor erneut aktuelle Raw Evidence bewerten, den Promotion Preflight ausführen, den Promotion Intent verifizieren, die aktuell aktiven Docker-Volumes erneut auflösen und den Execution Plan gegen **beides** verifizieren.

## Signatur und Persistenz

Datei:

```text
promotion-execution-plan.json
```

Signatur:

```text
HMAC-SHA256
masters:restore-private-promotion-execution-plan:v1
```

Persistenzregeln:

- Target-Verzeichnis `0700`,
- Plan-Datei `0600`,
- exklusives Anlegen,
- exakter Retry reused den byte-identischen Plan,
- geänderter Preflight oder aktiver Volume-Satz kann den bestehenden Plan nicht übernehmen,
- Tampering wird durch Struktur-, Fingerprint- und HMAC-Prüfung erkannt.

## Server-Contracts

`Restore Promotion Plan Contract` prüft mit echter libSQL-Restore-DB und signierter Restore-Evidence:

- frische Readiness-/Intent-/Preflight-Kette bis zum Plan,
- Plan-Erstellung und idempotente Wiederverwendung,
- `productionMutationAllowed=false`,
- unveränderte aktive Volumes als Rollback-Satz,
- keine Kandidaten-/Aktiv-Kollision,
- Plan-Datei `0600`,
- Active-Volume-Drift blockiert und verändert den vorhandenen Plan nicht.

`Restore Promotion Wiring Contract` prüft zusätzlich:

- Resolver gegen synthetische Compose-/Inspect-Evidence,
- Ablehnung eines Containers aus einem anderen Compose-Projekt,
- Bash-Syntax und read-only Host-Auflösung,
- keine Docker-Volume-Mutation im Wrapper,
- kein Docker-Socket im Plan-Service,
- keine produktiven Volume-Mounts im Plan-Service,
- nur `/restore-replay/promotion` schreibbar.

## Noch nicht implementiert

Der aktuelle Stand:

- erstellt keine Kandidaten-Volumes,
- kopiert keine Restore-Daten in Kandidaten,
- stoppt keine produktiven Dienste,
- verändert keine Compose-Selectoren,
- schaltet keinen Kandidaten aktiv,
- löscht keinen Rollback-Satz.

Als nächster Slice folgt die **Erzeugung und Befüllung der vier neuen Kandidaten-Volumes**, weiterhin ohne produktive Umschaltung. Danach braucht es einen Kandidaten-Healthcheck; erst ein weiterer Schritt darf den produktiven Selector wechseln.

Bis Promotion-Executor, Audit und praktischer RTO-Drill abgeschlossen sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
