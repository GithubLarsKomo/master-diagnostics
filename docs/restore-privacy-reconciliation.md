# Restore Privacy Reconciliation

## Zweck

Ein verschlüsseltes Backup kann personenbezogene Daten enthalten, die **nach dem Backup-Zeitpunkt** im Produktivsystem irreversibel anonymisiert wurden. Ein technisch intakter Restore darf diese Daten deshalb nicht allein aufgrund eines erfolgreichen Backup- oder Staging-Checks wieder produktiv verfügbar machen.

Der erste Reconciliation-Baustein erzeugt aus der aktuell laufenden Datenbank einen versionierten, fingerprintgebundenen technischen Ledger für genau ein bereits isoliert gestagtes Backup.

## Erzeugung

Nach

```bash
bash infra/backup/stage-club-restore.sh masters-backup-<timestamp>-<uuid>.mdbak
```

liefert der Staging-Befehl einen Namen der Form `restore-<timestamp>-<uuid>`. Solange die aktuelle Produktivdatenbank noch verfügbar ist, wird anschließend ausgeführt:

```bash
bash infra/backup/create-club-restore-privacy-ledger.sh restore-<timestamp>-<uuid>
```

Der Helper liest den Backup-Zeitpunkt **nicht** aus einem Operator-Parameter, sondern aus dem bereits verifizierten `manifest.json` des Stagings. Der Compose-Service `backup-privacy-ledger` verbindet sich read-only zur aktuellen libSQL-Datenbank und besitzt als einzigen Write-Mount den privaten Restore-Staging-Root.

Er schreibt mit `0600` und ohne Überschreiben:

```text
restore-<timestamp>-<uuid>/privacy-reconciliation-ledger.json
```

## Ledger v1

Einträge werden ausschließlich für irreversible Athleten-Anonymisierungen aufgenommen, deren `db_committed_at` nach dem Backup-Zeitpunkt und nicht nach dem Ledger-Erzeugungszeitpunkt liegt.

Berücksichtigt werden die Zustände:

- `DB_COMMITTED` – die fachlichen Daten wurden bereits irreversibel verändert; ein noch ausstehender Artefakt-Purge darf diese Privacy-Wirkung nicht verlieren,
- `COMPLETED` – DB-Commit und nachgelagerter Abschluss sind beendet.

Nicht berücksichtigt werden `PREPARING`, `ARTIFACTS_STAGED` und `ABORTED`, weil dort kein erfolgreicher irreversibler DB-Commit nachgewiesen ist.

Der Ledger enthält ausschließlich:

- Version,
- Backup- und Ledger-Zeitpunkt,
- Tenant-ID,
- technischen Athletenanker,
- Execution-ID,
- `db_committed_at`,
- technischen Execution-Status,
- deterministischen SHA-256-Fingerprint über den vollständigen kanonischen Ledger-Inhalt.

Namen, Geburtsdaten, Messwerte, Löschgründe, Audit-Freitexte und Reportinhalte werden nicht kopiert.

## Sicherheitsgrenze

Der Ledger **führt noch keine Reconciliation durch**. Er ist nur die fail-closed Anweisung, welche Privacy-Wirkungen ein älteres Staging mindestens wiederherstellen muss. Das Staging darf nach Ledger-Erzeugung weiterhin nicht produktiv verwendet oder promoted werden.

Der nächste Schritt muss den Ledger gegen eine isoliert gestartete Restore-Datenbank anwenden und anschließend beweisen, dass die betreffenden Subjekte dort den aktuellen irreversiblen Privacy-Zustand besitzen. Erst danach dürfen Healthcheck und Promotion folgen.

### Disaster-Recovery-Grenze

Der aktuelle v1-Pfad liest die noch verfügbare Live-Datenbank. Bei einem Totalausfall, bei dem die aktuelle Datenbank nicht mehr lesbar ist, reicht dieser Mechanismus allein nicht aus. Für eine belastbare produktive Backup-Attestation ist deshalb zusätzlich ein dauerhaft **außerhalb der Backup-Bundles** fortgeschriebener Privacy-Ledger erforderlich, der erfolgreiche `DB_COMMITTED`-Anonymisierungen über einen Ausfall der Primärdatenbank hinweg bewahrt.

Bis dieser persistente externe Ledger, die Anwendung der Reconciliation, Restore-Healthchecks und der kontrollierte Promotionspfad implementiert und praktisch getestet sind, bleibt `PRIVACY_BACKUP_STATE=DISABLED`.
