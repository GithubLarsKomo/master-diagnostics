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

## Host-Auflösung statt Vermutung

Der Plan-Core kennt keine Compose-Projektpräfixe und errät keine produktiven Docker-Volume-Namen. Die konkreten aktuell aktiven Namen werden dem Plan als technische Host-Evidence übergeben.

Sie werden validiert und gemeinsam als `activeVolumeSetFingerprint` gebunden. Ändert sich bis zur späteren Ausführung auch nur ein aktiver Volume-Name, kann der vorhandene Plan nicht mehr verifiziert werden.

Der nächste operative Slice muss diese vier Namen read-only aus dem tatsächlich gerenderten/running Club-Stack auflösen und erst danach den Plan persistieren.

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

Die Backup-Bundles enthalten zwar Caddy-Daten, aber die Privacy-Replay-Kette mutiert nur die vier fachlichen App-Datenbereiche. Eine Promotion dieser privaten Restore-Kopie darf deshalb nicht nebenbei ältere Zertifikats-/Caddy-Daten aktivieren.

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

Vor der späteren Mutation muss der Executor erneut:

1. aktuelle Raw Evidence bewerten,
2. Promotion Preflight neu ausführen,
3. den Promotion Intent verifizieren,
4. die aktuell aktiven Docker-Volumes erneut auflösen,
5. den Execution Plan gegen **beides** verifizieren.

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

Der bereits separate Promotion-Key wird mit eigener Domain Separation verwendet. Der Plan-Key ist damit kryptografisch vom Promotion Intent getrennt, obwohl dieselbe geheime Schlüsseldatei genutzt wird.

Persistenzregeln:

- Target-Verzeichnis `0700`,
- Plan-Datei `0600`,
- exklusives Anlegen,
- exakter Retry reused den byte-identischen Plan,
- geänderter Preflight oder aktiver Volume-Satz kann den bestehenden Plan nicht übernehmen,
- Tampering wird durch Struktur-, Fingerprint- und HMAC-Prüfung erkannt.

## Safety Policies

Execution Plan v1 verlangt exakt:

```text
switchStrategy = VERSIONED_EXTERNAL_NAMED_VOLUMES
rollbackStrategy = KEEP_PREVIOUS_ACTIVE_VOLUMES
caddyPolicy = PRESERVE_CURRENT
productionMutationAllowed = false
promotionExecuted = false
```

Abweichende Policies machen den Plan unverifizierbar.

## Noch nicht implementiert

Dieser Slice:

- erstellt keine Docker-Volumes,
- kopiert keine Restore-Daten,
- stoppt keine produktiven Dienste,
- verändert keine Compose-Selectoren,
- schaltet keinen Kandidaten aktiv,
- löscht keinen Rollback-Satz.

Als nächstes folgt die **read-only Host-Auflösung der aktuell aktiven Volume-Namen plus Plan-CLI/Persistenz**. Erst danach werden Kandidaten erstellt und befüllt; die eigentliche Produktionsumschaltung bleibt ein weiterer separater Schritt.

Bis Promotion-Executor, Audit und praktischer RTO-Drill abgeschlossen sind, bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```
