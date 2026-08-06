# Restore Privacy Reconciliation

## Zweck

Ein Restore aus einem älteren Backup darf personenbezogene Daten, die nach Erstellung dieses Backups irreversibel anonymisiert wurden, nicht wieder aktivieren. Deshalb ist ein technisch intaktes und erfolgreich gestagtes Backup allein noch nicht promotionsfähig.

## Kanonischer read-only Source

`getRestorePrivacyReconciliationLedger()` erzeugt den versionierten Vertrag `RESTORE_PRIVACY_LEDGER_VERSION = 1` aus der aktuellen Datenbank.

Der Aufrufer übergibt als `sinceExclusive` den `createdAt`-Zeitpunkt des ausgewählten Backup-Manifests. Berücksichtigt werden Anonymisierungs-Executions mit Status `DB_COMMITTED` oder `COMPLETED`, deren `dbCommittedAt` strikt nach diesem Zeitpunkt liegt.

`DB_COMMITTED` ist dabei absichtlich der privacy-effektive Zeitpunkt: Die irreversible Datenbankmutation ist bereits erfolgt. `COMPLETED` folgt erst nach erfolgreichem Purge der zuvor quarantänisierten externen Artefakte. Ein Crash zwischen diesen Zuständen darf deshalb nicht dazu führen, dass die bereits wirksame Datenschutzpflicht aus dem Restore-Ledger verschwindet.

Jeder Eintrag enthält nur die für eine spätere Reconciliation notwendigen technischen Bindungen:

- Tenant-ID,
- Athlete-ID,
- Execution-ID,
- Approval-ID,
- Deletion-Request-ID,
- Execution-Version,
- Anonymisierungs-Policy-Version,
- Scope-Fingerprint,
- Capability-Fingerprint,
- DB-Commit-Zeitpunkt der irreversiblen Verarbeitung.

Direkte Identifikatoren, Kontaktdaten, Freitextgründe, Reportinhalte oder Messwerte gehören ausdrücklich nicht in diesen Vertrag.

## Determinismus

Die Einträge werden deterministisch nach DB-Commit-Zeitpunkt, Tenant, Athlete und Execution sortiert. `entriesFingerprint` ist ein SHA-256 über Ledger-Version, Backup-Cutoff und die kanonische Entry-Liste.

`generatedAt` ist nur Metadatum und fließt nicht in den Inhaltsfingerprint ein. Derselbe fachliche Reconciliation-Scope erhält dadurch unabhängig vom Abfragezeitpunkt denselben Fingerprint.

## Warum dieser Ledger nicht Teil des wiederherzustellenden Backups sein darf

Ein Backup enthält nur den Datenschutzstatus zum Zeitpunkt seiner Erstellung. Würde der Reconciliation-Nachweis ausschließlich innerhalb desselben Backups gespeichert, würde ein Restore auf einen älteren Stand auch den Nachweis späterer Löschungen zurückrollen.

Für einen produktiven Restore ist deshalb ein **durabler, manipulationsgeschützter Nachweis außerhalb der Backup-Historie** erforderlich. Der in diesem Slice implementierte Service definiert dessen kanonischen read-only Source, persistiert ihn aber noch nicht extern.

Der spätere externe Writer muss spätestens ab `DB_COMMITTED` retrybar sein. Die finale `COMPLETED`-Transition darf nicht die einzige Quelle für den Restore-Nachweis sein.

## Fail-closed Restore-Gate

Ein isoliertes Restore-Staging darf erst promotionsfähig werden, wenn mindestens folgende Schritte erfolgreich sind:

1. Backup-Checksumme, AES-GCM und Archivstruktur verifizieren.
2. Backup ausschließlich außerhalb der Produktivvolumes stagen.
3. Einen vertrauenswürdigen externen Privacy-Ledger für den Zeitraum nach `manifest.createdAt` laden und validieren.
4. Alle dort enthaltenen Reconciliation-Pflichten auf das Staging anwenden oder nachweislich bereits erfüllt finden.
5. Danach Datenbank-/Anwendungs-Healthchecks ausführen.
6. Erst anschließend einen separaten kontrollierten Promotionsschritt erlauben.

Fehlt der externe Ledger, ist seine Integrität unklar oder kann eine Pflicht nicht eindeutig abgeglichen werden, bleibt die Promotion blockiert.

## Noch offen

Dieser Stand schreibt nichts in das Restore-Staging und nichts auf ein externes Ledger-Ziel. Die nächsten getrennten Slices sind:

- externe append-only bzw. manipulationsgeschützte Ledger-Persistenz außerhalb der Backup-Bundles,
- Verifikation dieses externen Ledgers,
- Anwendung der Reconciliation-Pflichten auf ein isoliertes Staging,
- Healthcheck, Promotion, Restore-Audit und praktischer RTO-Drill.

`PRIVACY_BACKUP_STATE` bleibt bis zum vollständigen Nachweis des produktiven Restore-Vertrags `DISABLED`.
