# Restore Privacy Reconciliation

## Zweck

Ein Restore aus einem älteren Backup darf personenbezogene Daten, die nach Erstellung dieses Backups irreversibel anonymisiert wurden, nicht wieder aktivieren. Ein technisch intaktes und erfolgreich gestagtes Backup ist deshalb allein noch nicht promotionsfähig.

## Externe Nachweisquellen

Die Restore-Seite verwendet zwei voneinander getrennte, außerhalb der Backup-Historie persistierte Nachweise:

1. den signierten **Restore Privacy Ledger**, der ein geschlossenes Beobachtungsfenster `(manifest.createdAt, generatedAt]` aus der Live-DB festhält,
2. das signierte **Privacy Effect Journal**, das jede irreversible Anonymisierung bereits vor dem DB-Commit mit `PENDING` und anschließend terminal mit `COMMITTED` oder `ABORTED` bindet.

Der Ledger ist damit ein konsistenter DB-Snapshot der bekannten privacy-effektiven Commits. Das Journal schließt zusätzlich die Disaster-Lücke nach dem letzten Ledger-Snapshot, weil es direkt im Writer-Pfad fortgeschrieben wird.

## Read-only Reconciliation Report v1

`createRestorePrivacyReconciliationReportFromStorage()` und der CLI-Befehl `backup:privacy-reconcile` erzeugen den versionierten Report `RESTORE_PRIVACY_RECONCILIATION_REPORT_VERSION = 1` ausschließlich aus:

- dem `manifest.json` des isolierten Restore-Stagings,
- dem externen Restore-Privacy-Ledger-Verzeichnis und dessen HMAC-Key,
- dem externen Privacy-Effect-Journal und dessen getrenntem HMAC-Key.

Die Live-Datenbank ist ausdrücklich **keine** Abhängigkeit. Der Report verändert weder das Restore-Staging noch Ledger oder Journal.

Für den ausgewählten Backup-Cutoff wird der jüngste kryptografisch verifizierte Ledger mit exakt demselben `sinceExclusive` verwendet. Zusätzlich werden alle signierten Journalmarker verifiziert und pro Execution zusammengeführt.

## Ergebniszustände

Der Report liefert genau einen der folgenden Zustände:

- `BLOCKED`: Die Datenschutzlage ist nicht eindeutig genug für eine Reconciliation.
- `REPLAY_REQUIRED`: Die Nachweise sind konsistent und mindestens eine nach dem Backup privacy-effektiv gewordene Anonymisierung muss auf dem Restore-Staging noch nachgezogen bzw. nachgewiesen werden.
- `CLEAR`: Die Nachweise sind konsistent und es existiert keine nach dem Backup liegende Replay-Pflicht.

`promotionAllowed` ist in diesem Slice **immer `false`**. Auch `CLEAR` autorisiert keine Promotion; Healthcheck, kontrollierte Promotion und Restore-Audit bleiben separate Gates.

## Fail-closed Blocker

Der Report blockiert insbesondere bei:

- fehlendem vertrauenswürdigem Ledger für den ausgewählten Backup-Cutoff,
- jedem `PENDING` ohne verifizierten terminalen Marker,
- Ledger-Eintrag plus terminalem `ABORTED` für dieselbe Execution,
- abweichender technischer Identity zwischen Ledger und Journal,
- abweichendem `dbCommittedAt` zwischen Ledger und Journal,
- einem `COMMITTED`-Journalmarker innerhalb des Ledger-Beobachtungsfensters, der im Ledger fehlt.

Ein `COMMITTED`-Journalmarker **nach** `ledger.generatedAt` ist dagegen zulässig und wird als Journal-only Replay-Pflicht übernommen. Genau dadurch bleibt ein Disaster nach dem letzten Ledger-Snapshot rekonstruierbar.

## Ledger-Härtung beim Lesen

Vor Verwendung prüft der Report zusätzlich zum HMAC:

- Ledger-Version und kanonische UTC-Zeitstempel,
- Observation Window und Entry-Zeitpunkte,
- positive Execution-Versionen und technische Fingerprint-Formate,
- eindeutige Execution-IDs,
- kanonische Entry-Sortierung,
- den neu berechneten `entriesFingerprint`,
- Übereinstimmung von Dateiname und signiertem Ledgerinhalt.

Strukturell inkonsistente oder kryptografisch ungültige Dateien führen zu einem harten Fehler statt zu einem verwertbaren Report.

## Replay-Pflichten

Jede Replay-Pflicht enthält ausschließlich die bereits minimierte technische Identity:

- Tenant-, Athlete-, Execution-, Approval- und Deletion-Request-ID,
- Execution- und Policy-Version,
- Scope- und Capability-Fingerprint,
- `dbCommittedAt`,
- Evidenzquelle `LEDGER`, `JOURNAL` oder beide.

Namen, Geburtsdaten, Kontakte, Gründe, Messwerte, Reportinhalte und andere direkte Fachdaten gehören nicht in diesen Vertrag.

## Read-only DB-Assessment v1

`assessRestorePrivacyReplayDatabase()` bewertet die **Datenbankhälfte** einer konsistenten Replay-Pflicht gegen eine ausschließlich isolierte Restore-Staging-Datenbank bzw. eine private Kopie davon.

Der Assessment-Status ist einer von:

- `BLOCKED`: Die signierte Pflicht kann nicht eindeutig gegen den Staging-Zustand aufgelöst werden, beispielsweise weil der gebundene Athlete-Anker fehlt.
- `DATABASE_REPLAY_REQUIRED`: Mindestens eine erwartete privacy-effektive DB-Wirkung fehlt noch.
- `DATABASE_SATISFIED`: Die Datenbankwirkung ist bereits technisch nachweisbar vorhanden.

`DATABASE_SATISFIED` verlangt gemeinsam:

- den deterministischen Athlete-Tombstone v1,
- keine Tests, Athlete-Snapshots, Coach-Zuordnungen oder Guardian-Datensätze,
- keine athletenbezogenen Betroffenenexport-Metadaten,
- konservativ keine Tenant-Export-Metadaten im betroffenen Tenant,
- den exakt gebundenen abgeschlossenen `deletionRequestId`,
- redigierte Freitexte aller Löschrequests des Athleten.

Die **signierte externe Replay-Pflicht selbst** ist dabei der Nachweis, warum dieser Zielzustand hergestellt sein muss. Ein Backup mit `backupCutoff < dbCommittedAt` kann den ursprünglichen späteren `athlete.anonymization_db_committed`-Auditdatensatz definitionsgemäß nicht enthalten; dessen künstliche Rekonstruktion wäre daher kein zulässiges Erfüllungskriterium. Das Assessment prüft stattdessen den vollständigen technischen Zielzustand gegen die kryptografisch gebundene Obligation.

Der Assessment-Output enthält nur technische IDs, Reason-Codes und Zähler. Er verändert keine Daten.

Wichtig: `DATABASE_SATISFIED` ist **kein vollständiger Replay-Nachweis**. Report-, Tenant-Export- und Betroffenenexportdateien im Staging müssen weiterhin separat geprüft bzw. kontrolliert entfernt werden. `promotionAllowed` bleibt daher auch bei vollständig erfüllter Datenbankhälfte `false`.

## Club-Betrieb

Der Host-Wrapper

```sh
bash infra/backup/reconcile-club-restore-privacy.sh restore-<timestamp>-<uuid>
```

startet den Compose-Service `backup-privacy-reconcile`.

Dieser Service besitzt ausschließlich read-only Mounts auf:

- das Restore-Staging,
- den Restore-Privacy-Ledger,
- den Ledger-Key,
- das Privacy-Effect-Journal,
- den Journal-Key.

Er mountet keine Produktivvolumes und besitzt keine `DATABASE_URL`-Abhängigkeit.

Das DB-Assessment ist als eigener Fachvertrag vorhanden, wird in diesem Slice aber noch **nicht** automatisch gegen den gestagten libSQL-Stand gestartet. Der folgende Betriebs-Slice muss dafür eine private, nicht promotionsfähige Staging-DB-Kopie bereitstellen und ausschließlich diese an den Assessment-/Replay-Pfad anbinden.

## Verbleibende Restore-Slices

Als nächste Schritte bleiben:

1. isolierte Staging-DB-Kopie für Assessment/Replay starten,
2. noch offene DB-Replay-Wirkungen kontrolliert anwenden,
3. Report-/Exportartefakte im Staging reconciliieren,
4. Datenbank-/Anwendungs-Healthcheck im Staging,
5. kontrollierte Promotion/Rückschreibung,
6. Restore-Audit,
7. praktischer RTO-Drill.

Bis diese Schritte praktisch nachgewiesen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
