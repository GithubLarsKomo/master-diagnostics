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

`promotionAllowed` bleibt auch nach einem erfolgreichen Datenbank-Replay **immer `false`**. Weder `CLEAR` noch `DATABASE_SATISFIED` autorisieren eine Promotion; Artifact-Replay, Healthcheck, kontrollierte Promotion und Restore-Audit bleiben separate Gates.

## Fail-closed Blocker

Der Report blockiert insbesondere bei:

- fehlendem vertrauenswürdigem Ledger für den ausgewählten Backup-Cutoff,
- jedem `PENDING` ohne verifizierten terminalen Marker,
- Ledger-Eintrag plus terminalem `ABORTED` für dieselbe Execution,
- abweichender technischer Identity zwischen Ledger und Journal,
- abweichendem `dbCommittedAt` zwischen Ledger und Journal,
- einem `COMMITTED`-Journalmarker innerhalb des Ledger-Beobachtungsfensters, der im Ledger fehlt.

Ein `COMMITTED`-Journalmarker **nach** `ledger.generatedAt` ist dagegen zulässig und wird als Journal-only Replay-Pflicht übernommen. Genau dadurch bleibt ein Disaster nach dem letzten Ledger-Snapshot rekonstruierbar.

## Ledger- und Journal-Härtung beim Lesen

Vor Verwendung prüft der Report zusätzlich zum HMAC:

- Ledger-Version und kanonische UTC-Zeitstempel,
- Observation Window und Entry-Zeitpunkte,
- positive Execution-Versionen und technische Fingerprint-Formate,
- eindeutige Execution-IDs,
- kanonische Entry-Sortierung,
- den neu berechneten `entriesFingerprint`,
- Übereinstimmung von Dateiname und signiertem Ledgerinhalt,
- identische technische Identity zwischen `PENDING` und Terminalmarker,
- monotone Zeitfolge zwischen Intent und Terminalzustand.

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

Wichtig: Ein fehlender Athlete-Anker ist **nicht automatisch privacy-sicher**. Er wird als `BLOCKED / ATHLETE_STATE_UNRESOLVED` behandelt, weil die signierte Pflicht ohne eindeutigen Staging-Anker nicht bewiesen werden kann.

`DATABASE_SATISFIED` ist **kein vollständiger Replay-Nachweis**. Report-, Tenant-Export- und Betroffenenexportdateien im Staging müssen weiterhin separat geprüft bzw. kontrolliert entfernt werden. `promotionAllowed` bleibt daher auch bei vollständig erfüllter Datenbankhälfte `false`.

## Assessment-gesteuerter Datenbank-Replay

Der CLI-Befehl `backup:privacy-replay-db` verbindet Reconciliation, Assessment und Write-Pfad fail-closed:

1. Der signierte Reconciliation-Report wird erneut erzeugt und muss nicht `BLOCKED` sein.
2. `assessRestorePrivacyReplayDatabase()` bewertet die private Restore-DB **vor** jedem Write.
3. Ein `BLOCKED`-Assessment beendet den Lauf ohne Replay.
4. Bereits `DATABASE_SATISFIED`e Pflichten werden nicht erneut geschrieben.
5. Nur `DATABASE_REPLAY_REQUIRED`e Pflichten werden sequenziell angewandt.
6. Nach den Writes wird derselbe read-only Assessment-Vertrag erneut ausgeführt.
7. Der Lauf gilt nur dann als erfolgreich, wenn der Gesamtstatus anschließend exakt `DATABASE_SATISFIED` ist.

Der Replay verwendet bewusst **nicht** den normalen produktiven Anonymisierungs-Commit. Ein ausgewähltes älteres Backup kann die später entstandenen Approval- und Execution-Zeilen noch gar nicht enthalten. Stattdessen ist jede Operation ausschließlich an die externe, signierte technische Replay-Pflicht gebunden.

Für geschützte immutable Tabellen existiert Migration `0022_restore_privacy_replay`. Sie erlaubt die notwendigen Deletes nur, solange innerhalb derselben DB-Transaktion eine technisch identische `ACTIVE`-Replay-Autorisierung für Tenant und Athlete existiert. Die Autorisierung:

- startet ausschließlich als `ACTIVE`,
- kann nur `ACTIVE -> APPLIED` wechseln,
- besitzt immutable technische Identity und Original-`dbCommittedAt`,
- kann nicht gelöscht werden,
- wird im Fehlerfall zusammen mit der gesamten DB-Transaktion zurückgerollt.

Damit entsteht kein dauerhafter generischer Delete-Bypass. Bestehende `ARTIFACTS_STAGED`-Triggerpfade für die normale produktive Anonymisierung bleiben unverändert nutzbar.

Der DB-Replay stellt den vom Assessment geforderten privacy-sicheren Endzustand idempotent wieder her:

- Audit-Altbestand wird mit dem bestehenden Privacy-Redaction-Vertrag minimiert,
- individuelle Test-, Mess-, Diagnostik-, Interpretations- und Reportdaten werden entfernt,
- Athlete-Snapshots, Coach-Zuordnungen und Guardian-Daten werden entfernt,
- Consent-Nachweise bleiben als minimierte Compliance-Historie erhalten,
- Löschworkflow-Freitexte werden redigiert,
- der Athlet erhält denselben deterministischen Tombstone wie im Produktivpfad,
- falls ein älteres Backup den Athleten noch aktiv enthält, werden `deletedAt` und `consentBlockedAt` spätestens auf das originale `dbCommittedAt` gesetzt,
- athletenbezogene Betroffenenexport-Paketmetadaten werden entfernt,
- alle vollständigen Tenant-Export-Paketmetadaten des betroffenen Tenants werden konservativ invalidiert, weil ein vollständiger Tenant-Export den wiederhergestellten Athleten enthalten kann,
- der exakt signierte `deletionRequestId` wird als minimierter `COMPLETED`-Anker erhalten oder – falls er nach dem Backup entstanden und deshalb im Staging noch nicht vorhanden ist – ausschließlich mit technischen Bindungen, redigierten Textfeldern und dem originalen `dbCommittedAt` rekonstruiert.

Fehlt der gebundene Athlete-Anker, findet **kein** Replay statt. Eine bereits identisch `APPLIED` quittierte Pflicht ist ein idempotenter `ALREADY_APPLIED`-Retry. Abweichende Receipt- oder Deletion-Request-Identity blockiert fail-closed.

## Private Replay-Arbeitskopie

Der Host-Wrapper

```sh
bash infra/backup/replay-club-restore-privacy-db.sh restore-<timestamp>-<uuid>
```

verändert **nicht** das unmittelbar extrahierte Restore-Staging. Er erzeugt zunächst atomar eine private Arbeitskopie von

```text
RESTORE_STAGING_HOST_DIR/<staging>/libsql
```

unter

```text
RESTORE_PRIVACY_REPLAY_HOST_DIR/<staging>/libsql
```

und setzt Assessment und Replay ausschließlich auf dieser Kopie fort. Ein bereits vorhandener vollständiger Workspace wird für idempotente Wiederholungen wiederverwendet; ein unvollständiger Workspace blockiert fail-closed.

## Isolierter Compose-Stack

Drei Backup-Profile bilden den DB-Replay ab:

1. `backup-privacy-replay-db` startet den gepinnten libSQL-Server ausschließlich auf der privaten Replay-Arbeitskopie.
2. `backup-privacy-replay-migrate` migriert nur diese Kopie auf das aktuelle Schema und installiert damit auch den begrenzten Restore-Replay-Vertrag.
3. `backup-privacy-replay` liest Restore-Manifest, Ledger und Journal read-only, führt das Pre-Assessment aus, wendet ausschließlich notwendige Pflichten auf die isolierte DB an und verlangt anschließend `DATABASE_SATISFIED`.

Alle drei Services laufen ausschließlich im internen Netzwerk `restore-internal`. Der Replay-DB-Service mountet genau einen schreibbaren Host-Pfad: die private Replay-Kopie auf `/var/lib/sqld`. Produktive Named Volumes für libSQL, Reports, Tenant-Exporte, Betroffenenexporte oder Caddy werden nicht gemountet. Ledger, Journal, Keys und ursprüngliches Restore-Staging bleiben read-only.

Der bestehende Wrapper

```sh
bash infra/backup/reconcile-club-restore-privacy.sh restore-<timestamp>-<uuid>
```

bleibt der vollständig read-only Nachweis vor dem DB-Replay und besitzt weiterhin keine `DATABASE_URL`-Abhängigkeit.

## Verbleibende Restore-Slices

Dieser Stand reconciliiert die externen Nachweise, bewertet die Datenbankhälfte read-only und stellt den privacy-sicheren **Datenbankzustand** auf einer privaten Restore-Kopie kontrolliert her. Noch nicht umgesetzt sind externe Storage-Artefakte, deren DB-Referenzen beim Replay entfernt wurden. Deshalb bleibt jede Promotion blockiert.

Die nächsten getrennten Schritte sind:

1. Report-, Tenant-Export- und Betroffenenexport-Artefakte auf privaten Restore-Arbeitskopien entfernen bzw. als bereits abwesend nachweisen,
2. Datenbank-/Anwendungs-Healthcheck auf dem vollständig reconciliierten Staging,
3. kontrollierte Promotion/Rückschreibung,
4. Restore-Audit,
5. praktischer RTO-Drill.

Bis diese Schritte praktisch nachgewiesen sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
