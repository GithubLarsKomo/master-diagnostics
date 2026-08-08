# Restore Privacy Artifact Replay

## Zweck

Der Restore-DB-Replay entfernt absichtlich Report-, Tenant-Export- und Betroffenenexport-Metadaten aus der privaten Restore-Datenbank. Die zugehörigen Dateien liegen jedoch in separaten Storage-Verzeichnissen. Deshalb müssen deren technischen Storage-Referenzen **vor** dem DB-Replay unveränderlich festgehalten werden, damit ein späterer Artifact-Replay die privaten Restore-Kopien vollständig bereinigen kann.

Der Artifact-Plan ist kein Promotion-Gate und löscht in diesem Slice noch keine Datei.

## Private Restore-Arbeitskopie

`infra/backup/replay-club-restore-privacy-db.sh <staging-name>` kopiert atomar genau diese Restore-Quellen aus dem unveränderten Staging in den privaten Workspace:

```text
libsql/
reports/
tenant-exports/
data-subject-delivery/
```

Ziel ist:

```text
RESTORE_PRIVACY_REPLAY_HOST_DIR/<staging-name>/
```

Das ursprüngliche Restore-Staging bleibt unverändert. Ein vorhandener Workspace ist nur retrybar, wenn alle vier Verzeichnisse vollständig vorhanden sind; ein partieller Workspace blockiert fail-closed.

## Artifact Replay Manifest v1

Vor dem DB-Replay erzeugt `backup:privacy-artifact-plan` im privaten Workspace:

```text
artifact-replay-manifest.json
```

Der Plan enthält ausschließlich technische Restore-Daten:

- Backup-Cutoff und Reconciliation-Status,
- Bindung an Ledger-Generation/-Fingerprint und Journal-Markerzahl,
- Fingerprint der kryptografisch reconciliierten Replay-Obligations,
- `REPORT`-Storage-Referenzen für betroffene Athleten,
- `DATA_SUBJECT_DELIVERY`-Storage-Referenzen für betroffene Athleten,
- konservativ **alle** `TENANT_EXPORT`-Storage-Referenzen jedes betroffenen Tenants,
- die jeweils gebundenen Execution-IDs,
- kanonische SHA-256-Fingerprints der Manifest-Einträge.

Namen, Geburtsdaten, Kontakte, Löschgründe, Messwerte, Reportinhalte und andere Fachinhalte gehören nicht in das Manifest.

## Warum Tenant-Exports vollständig invalidiert werden

Ein vollständiger Tenant-Export kann einen Athleten enthalten, ohne dass die Export-Paketmetadaten selbst eine Athlete-ID tragen. Sobald mindestens eine post-backup Privacy-Obligation einen Tenant betrifft, werden deshalb alle im ausgewählten Restore-Snapshot vorhandenen Tenant-Export-Artefakte dieses Tenants in den Replay-Plan aufgenommen.

Das entspricht dem Datenbank-Replay, der die zugehörigen Tenant-Export-Metadaten ebenfalls konservativ vollständig entfernt.

## Fail-closed Pfadvalidierung

Storage-Referenzen werden vor Aufnahme in den Plan gegen dieselben technischen Konventionen wie die produktiven Storage-Adapter geprüft:

- Reports: relative `.pdf`-Pfade ohne Traversal; zusätzlich Tenant-/Test-Scope aus der Restore-DB,
- Tenant-Exports: sichere `.mde`-Referenzen,
- Betroffenenexporte: UUID-basierte `.mdse`-Referenzen.

Absolute Pfade, `..`, Scope-Abweichungen oder unbekannte Typen blockieren die Planerstellung.

## Determinismus und Retry

Das Manifest ist kanonisch sortiert und bindet sowohl die Obligation-Liste als auch die Artifact-Entries über SHA-256-Fingerprints.

Beim ersten Lauf wird es mit Dateimodus `0600` in einem privaten `0700`-Workspace erzeugt. Ein späterer Retry nach bereits erfolgtem DB-Replay darf die inzwischen gelöschten DB-Metadaten **nicht** erneut als Quelle verwenden. Deshalb gilt:

1. Existiert noch kein Manifest, wird es aus der privaten Restore-DB vor dem DB-Replay aufgebaut.
2. Existiert bereits ein Manifest, wird es ausschließlich gegen die aktuell verifizierte Ledger-/Journal-Reconciliation validiert.
3. Stimmt die Evidenzbindung, wird der bestehende Plan unverändert wiederverwendet.
4. Abweichende Evidenz, Fingerprints, Entries oder Scope-Bindungen blockieren fail-closed.

Damit bleibt der gesamte Restore-Replay auch nach einem bereits erfolgreich angewandten DB-Replay idempotent wiederholbar.

## Compose-Reihenfolge

Der private Restore-Pfad lautet:

```text
private workspace copy
  -> backup-privacy-replay-migrate
  -> backup-privacy-artifact-plan
  -> backup-privacy-replay
```

`backup-privacy-artifact-plan` läuft ausschließlich im internen Netzwerk `restore-internal`, liest Restore-Manifest, Ledger, Journal und Keys read-only und besitzt genau einen schreibbaren Restore-Mount: den privaten Workspace auf `/restore-replay`.

Produktive libSQL-, Report-, Export-, Betroffenenexport- oder Caddy-Volumes werden nicht eingebunden.

## Scope-Grenze

Dieser Slice bewahrt nur die Löschinformation und die privaten Artifact-Kopien. Er entfernt noch keine Artifact-Dateien und setzt `promotionAllowed` nicht auf `true`.

Nächster Slice:

1. `artifact-replay-manifest.json` verifizieren,
2. referenzierte Dateien ausschließlich in `reports/`, `tenant-exports/` und `data-subject-delivery/` des privaten Workspaces entfernen oder ihre Abwesenheit idempotent nachweisen,
3. ein technisches Artifact-Replay-Ergebnis mit verbleibenden Blockern erzeugen.

Erst danach folgen Healthcheck, kontrollierte Promotion, Restore-Audit und praktischer RTO-Drill. Bis dahin bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
