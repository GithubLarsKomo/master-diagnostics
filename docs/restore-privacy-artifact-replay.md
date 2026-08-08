# Restore Privacy Artifact Replay

## Zweck

Der Restore-DB-Replay entfernt absichtlich Report-, Tenant-Export- und Betroffenenexport-Metadaten aus der privaten Restore-Datenbank. Die zugehörigen Dateien liegen jedoch in separaten Storage-Verzeichnissen. Deshalb werden deren technische Storage-Referenzen **vor** dem DB-Replay unveränderlich festgehalten und **nach** dem erfolgreichen DB-Replay ausschließlich auf der privaten Restore-Kopie entfernt.

Dieser Pfad bleibt ein Vorbereitungs- und Verifikationsschritt. Er erlaubt noch keine Promotion.

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

Storage-Referenzen werden bereits bei der Manifest-Erzeugung gegen die produktiven technischen Konventionen geprüft. Der eigentliche Artifact-Replay validiert zusätzlich vor jeder Mutation:

- alle drei Storage-Roots sind absolute, existierende, voneinander getrennte Nicht-Symlink-Verzeichnisse,
- Reports bleiben relative `.pdf`-Pfade im gebundenen Tenant-Scope,
- Tenant-Exports bleiben sichere `.mde`-Referenzen,
- Betroffenenexporte bleiben UUID-basierte `.mdse`-Referenzen,
- kein Referenzpfad ist absolut, enthält `..` oder Windows-Backslashes,
- kein existierender Pfadbestandteil vom Storage-Root bis zum Ziel ist ein Symlink,
- ein vorhandenes Ziel muss eine reguläre Datei sein.

Damit kann ein manipuliertes oder unerwartetes Verzeichnislayout den Replay nicht aus der privaten Storage-Kopie herausführen.

## Replay und idempotente Abwesenheit

`backup:privacy-artifact-replay` startet erst nach erfolgreichem `backup-privacy-replay`.

Für jeden manifestierten Eintrag gilt:

1. Zielpfad im passenden privaten Storage-Root erneut validieren.
2. Vorhandene reguläre Datei löschen.
3. Bereits fehlende Datei als idempotent erfüllte Privacy-Anforderung akzeptieren.
4. Nach dem gesamten Durchlauf jeden Manifest-Eintrag erneut prüfen und nur fortfahren, wenn alle gebundenen Zielartefakte tatsächlich abwesend sind.

Nicht manifestierte Dateien werden nicht angefasst. Insbesondere werden `.anonymization-quarantine`-Bestände aus einem bereits zum Backup-Zeitpunkt laufenden Anonymisierungsvorgang in diesem Slice bewusst **nicht** pauschal gelöscht. Deren Konsistenz gehört in den nachfolgenden Restore-Healthcheck, weil sie den Datenbankzustand am Backup-Cutoff widerspiegeln können.

## Artifact Replay Result v1

Nach vollständig verifizierter Abwesenheit schreibt der Replay deterministisch:

```text
artifact-replay-result.json
```

Der technische Abschlussnachweis enthält nur:

- Result-/Manifest-Version,
- Backup-Cutoff und Reconciliation-Status,
- Obligation-Anzahl und -Fingerprint,
- Entry-Anzahl und -Fingerprint,
- Anzahl der als abwesend verifizierten Manifest-Einträge,
- `promotionAllowed: false`.

Er enthält absichtlich keinen Laufzeitstempel und keine variablen „gelöscht vs. schon fehlend“-Zähler. Dadurch ist der persistierte Nachweis bei jedem Retry byte-identisch. Der erste Write erfolgt mit `0600` im `0700`-Workspace; identische Wiederholungen sind idempotent, abweichender bestehender Inhalt blockiert fail-closed.

Die CLI-Ausgabe darf für die aktuelle Ausführung zusätzlich `removedCount` und `alreadyAbsentCount` melden; diese Werte sind nicht Teil des unveränderlichen Abschlussnachweises.

## Determinismus und Retry

Das Manifest ist kanonisch sortiert und bindet sowohl die Obligation-Liste als auch die Artifact-Entries über SHA-256-Fingerprints.

Beim ersten Lauf wird es mit Dateimodus `0600` in einem privaten `0700`-Workspace erzeugt. Ein späterer Retry nach bereits erfolgtem DB-Replay darf die inzwischen gelöschten DB-Metadaten **nicht** erneut als Quelle verwenden. Deshalb gilt:

1. Existiert noch kein Manifest, wird es aus der privaten Restore-DB vor dem DB-Replay aufgebaut.
2. Existiert bereits ein Manifest, wird es ausschließlich gegen die aktuell verifizierte Ledger-/Journal-Reconciliation validiert.
3. Stimmt die Evidenzbindung, wird der bestehende Plan unverändert wiederverwendet.
4. Vor dem Artifact-Replay wird ein vorhandenes `artifact-replay-result.json` ebenfalls gegen genau dieses verifizierte Manifest geprüft.
5. Der Dateireplay selbst ist idempotent: bereits abwesende Zielartefakte bleiben ein erfüllter Zustand.
6. Abweichende Evidenz, Fingerprints, Entries, Scope-Bindungen oder ein widersprüchlicher Abschlussnachweis blockieren fail-closed.

Damit bleibt der gesamte Restore-Replay auch nach einem bereits erfolgreich angewandten DB- und Artifact-Replay wiederholbar.

## Compose-Reihenfolge

Der private Restore-Pfad lautet jetzt:

```text
private workspace copy
  -> backup-privacy-replay-migrate
  -> backup-privacy-artifact-plan
  -> backup-privacy-replay
  -> backup-privacy-artifact-replay
```

`backup-privacy-artifact-plan` und `backup-privacy-artifact-replay` laufen ausschließlich im internen Netzwerk `restore-internal`. Restore-Manifest, Ledger, Journal und Keys sind read-only eingebunden. Der einzige schreibbare Restore-Mount ist jeweils der private Workspace auf `/restore-replay`.

Der Artifact-Replay erhält keine produktiven libSQL-, Report-, Export-, Betroffenenexport- oder Caddy-Volumes. Seine drei löschbaren Storage-Roots liegen ausschließlich unter `/restore-replay`.

## Scope-Grenze

Mit diesem Slice sind post-backup Privacy-Obligations auf der privaten Restore-Kopie sowohl in der Datenbank als auch für die vor dem DB-Replay inventarisierten aktiven Storage-Artefakte replaybar und technisch nachweisbar.

Noch offen bleiben insbesondere:

1. Healthcheck des vollständigen privaten Restore-Zustands, einschließlich transienter/quarantänierter Artifact-Zustände am Backup-Cutoff,
2. kontrolliertes Promotion-Gate, das DB-Replay, Artifact-Replay und Healthcheck gemeinsam bindet,
3. Restore-Audit und praktischer RTO-Drill.

Bis diese Punkte abgeschlossen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED` und jeder Artifact-Replay-Output enthält `promotionAllowed: false`.
