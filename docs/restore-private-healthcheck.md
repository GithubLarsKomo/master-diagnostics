# Private Restore Healthcheck

## Zweck

Nach erfolgreicher Restore-Privacy-Reconciliation, DB-Replay und Artifact-Replay braucht die private Restore-Kopie einen read-only Konsistenzcheck, bevor überhaupt über eine Promotion gesprochen werden darf.

Der Healthcheck verändert weder Datenbank noch Dateien und erteilt selbst keine Promotion-Freigabe. Auch ein vollständig grüner Lauf liefert daher weiterhin `promotionAllowed: false`.

## Healthcheck v1

`backup:restore-healthcheck` verbindet vier bereits vorhandene Evidenz- und Zustandsquellen:

1. die signierte Restore-Privacy-Reconciliation,
2. den aktuellen DB-Zustand der privaten Restore-Kopie,
3. das verifizierte `artifact-replay-manifest.json` plus `artifact-replay-result.json`,
4. die drei privaten Artifact-Roots `reports/`, `tenant-exports/` und `data-subject-delivery/`.

Ein gesunder Zustand benötigt gleichzeitig:

- Reconciliation ist nicht `BLOCKED`,
- DB-Assessment ist `DATABASE_SATISFIED`,
- Artifact-Manifest passt weiterhin zur signierten Reconciliation,
- Artifact-Replay-Result passt weiterhin exakt zum Manifest,
- jede aktive DB-Storage-Referenz besitzt genau eine entsprechende reguläre Datei,
- jede aktive Datei besitzt eine entsprechende DB-Storage-Referenz,
- keine Symlinks oder Sonderdateien liegen in den Artifact-Roots,
- keine nichtleeren `.anonymization-quarantine`-Bestände existieren,
- keine Anonymisierung steht in `PREPARING`, `ARTIFACTS_STAGED` oder `DB_COMMITTED`.

## Warum Transient-State blockiert

Ein Backup kann während einer laufenden Anonymisierung entstehen. Dann kann die private Restore-Kopie beispielsweise:

- bereits verschobene Artifact-Dateien in `.anonymization-quarantine` enthalten,
- noch unveränderte DB-Daten bei `ARTIFACTS_STAGED` enthalten,
- oder bereits DB-commitete Daten bei noch nicht abgeschlossenem Artifact-Purge (`DB_COMMITTED`).

Diese Zustände sind nicht pauschal als „löschen“ oder „zurückrollen“ interpretierbar. Healthcheck v1 meldet sie deshalb ausschließlich als Blocker. Eine spätere Recovery-Policy muss anhand der gebundenen Execution-/Journal-Evidenz explizit festlegen, ob ein einzelner Zustand fortgesetzt oder abgebrochen werden darf.

Auch `PREPARING` blockiert zunächst: Es hat zwar noch keine irreversible Wirkung, würde nach Restore aber einen alten, noch offenen Ausführungszustand wieder aktivieren. Eine Promotion soll solche historischen Workflow-Zustände nicht stillschweigend übernehmen.

## Storage-Konsistenz

Für jeden privaten Artifact-Root wird deterministisch verglichen:

- Anzahl der DB-Referenzen,
- Anzahl aktiver regulärer Dateien,
- Anzahl Quarantäne-Dateien,
- Anzahl Symlinks,
- Anzahl sonstiger Sonderdateien.

Blockiert werden unter anderem:

- `ACTIVE_ARTIFACT_MISSING`,
- `ACTIVE_ARTIFACT_ORPHANED`,
- `STORAGE_SYMLINK_PRESENT`,
- `STORAGE_SPECIAL_ENTRY_PRESENT`,
- `ANONYMIZATION_QUARANTINE_NOT_EMPTY`.

Das verhindert sowohl fehlende Report-/Export-Dateien als auch verwaiste Dateien, die nach einem Restore weiterhin sensible Inhalte tragen könnten, obwohl keine aktive DB-Metadatenzeile mehr auf sie verweist.

## Technischer Output

Der Report enthält nur technische IDs, Storage-Referenzen, Statuswerte, Zähler und Blocker-Codes. Namen, Kontakte, Löschgründe, Messwerte oder Reportinhalte werden nicht ausgegeben.

Wichtige Felder:

- `status = HEALTHY | BLOCKED`,
- `healthcheckPassed`,
- `readyForPromotionReview`,
- `promotionAllowed = false`,
- `databaseStatus`,
- `artifactManifestVerified`,
- `artifactReplayVerified`,
- Storage-Zähler,
- transiente Execution-IDs und Status,
- kanonisch sortierte Blocker.

Der CLI-Prozess endet bei `BLOCKED` mit einem Fehlerstatus, bleibt aber vollständig read-only.

## Scope-Grenze

Dieser Slice definiert und testet ausschließlich den Healthcheck-Vertrag und die CLI. Die operative Compose-/Wrapper-Verkettung folgt separat, damit der neue Betriebsablauf erst nach grünem Contract verdrahtet wird.

Danach bleiben als nächste Schritte:

1. Healthcheck im isolierten Restore-Stack direkt hinter Artifact-Replay verdrahten,
2. eine explizite Recovery-Policy für historische Transient-/Quarantäne-Zustände festlegen,
3. kontrolliertes Promotion-Gate bauen,
4. praktischen Restore-/RTO-Drill durchführen.

Bis diese Schritte abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
