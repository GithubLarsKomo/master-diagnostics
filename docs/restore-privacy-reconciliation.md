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

## Verbleibende Restore-Slices

Der nächste Schritt ist die **kontrollierte Anwendung** der konsistenten Replay-Pflichten auf eine isolierte Staging-Datenbank. Erst danach folgen:

1. Datenbank-/Anwendungs-Healthcheck im Staging,
2. kontrollierte Promotion/Rückschreibung,
3. Restore-Audit,
4. praktischer RTO-Drill.

Bis diese Schritte praktisch nachgewiesen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
