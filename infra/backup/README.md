# Backup-Grundkonzept

## Aktueller Stand

Epic 12 stellt zunächst einen **manuellen Full-Volume-Backup-Bundle-Pfad** bereit. Er ist absichtlich noch kein produktiver Tages-Scheduler und rechtfertigt noch **nicht** `PRIVACY_BACKUP_STATE=ENABLED`.

Verbindliche Ziele aus SPEC §40 bleiben:

- tägliches konsistentes Backup,
- Verschlüsselung vor Ablage,
- 30 tägliche Sicherungen als Standard,
- lokales/NAS-Ziel, optional später S3-kompatibel,
- Integritätsprüfung,
- dokumentierter und protokollierter Restore-Test,
- RPO maximal 24 Stunden und RTO-Ziel 4 Stunden.

## Warum Clean-Shutdown statt Live-Volume-Kopie?

libSQL verwendet WAL-/Replikationszustand im persistenten Datenverzeichnis. Eine laufende Docker-Volume-Kopie würde daher eine Konsistenzbehauptung machen, die das Backup-System nicht garantieren kann.

`infra/backup/create-club-backup.sh` verwendet deshalb für den ersten belastbaren Backup-Pfad eine konservative Grenze:

1. der Backup-Helper wird vor Beginn der Downtime gebaut,
2. Caddy, Web-App und Maintenance-Writer werden beendet,
3. libSQL wird anschließend mit erweitertem Shutdown-Timeout sauber beendet,
4. erst dann werden die persistenten Volumes read-only in den Backup-Helper eingebunden,
5. der Helper streamt ein Tar-Archiv direkt durch AES-256-GCM in das Backup-Ziel,
6. nach Erfolg oder Fehler wird der reguläre Club-Stack wieder gestartet.

Damit wird kein laufendes WAL-Verzeichnis kopiert und kein Docker-Socket in einen Backup-Container gemountet.

## Geschützte Datenquellen

Bundle-Version 1 enthält:

- `libsql-data` – Datenbankzustand,
- `report-data` – persistierte Report-PDFs,
- `export-data` – noch vorhandene Tenant-Exportpakete,
- `data-subject-delivery-data` – noch vorhandene Betroffenenexportpakete,
- `caddy-data` – TLS-/PKI-Zustand,
- `caddy-config` – persistenter Caddy-Laufzeitzustand.

Das Manifest im verschlüsselten Archiv enthält nur technische Metadaten: Bundle-Version, Erstellungszeitpunkt, Konsistenzmodus, Verschlüsselungsverfahren, Restore-Reconciliation-Pflicht und die Quellklassen.

## Schlüssel und Ziel vorbereiten

Der Backup-Schlüssel muss **getrennt vom Backup-Ziel** gesichert werden. Er darf weder in Git noch gemeinsam mit den verschlüsselten Bundles abgelegt werden.

Beispiel auf dem Club-Host:

```bash
sudo install -d -m 700 /etc/master-diagnostics
openssl rand -base64 32 | sudo tee /etc/master-diagnostics/backup.key >/dev/null
sudo chmod 600 /etc/master-diagnostics/backup.key

sudo install -d -m 700 /var/backups/master-diagnostics
```

In `.env`:

```dotenv
BACKUP_HOST_DIR=/var/backups/master-diagnostics
BACKUP_KEY_FILE=/etc/master-diagnostics/backup.key
```

Das Key-File muss Base64 enthalten, das exakt 32 Byte entschlüsselt.

## Manuellen Bundle-Lauf ausführen

Vom Repository aus:

```bash
bash infra/backup/create-club-backup.sh
```

Der Lauf benötigt `docker`, Docker Compose v2 und `flock` auf dem Host. Ein exklusiver Lock verhindert parallele Backup-Läufe.

Ein erfolgreicher Lauf erzeugt ausschließlich:

```text
masters-backup-<timestamp>-<uuid>.mdbak
masters-backup-<timestamp>-<uuid>.mdbak.sha256
```

`.mdbak` ist AES-256-GCM-verschlüsselt. Das Klartext-Tar wird nicht auf das Backup-Ziel geschrieben. Die `.sha256`-Datei dient als schneller Transport-/Dateiintegritätscheck; die GCM-Authentifizierung schützt zusätzlich den entschlüsselten Inhalt gegen Manipulation.

## Datenschutzgrenze

Ein Backup kann ältere, inzwischen gelöschte oder anonymisierte Fachdaten enthalten. Deshalb bleibt die globale Backup-Capability vorerst `DISABLED`, obwohl der manuelle Bundle-Mechanismus technisch existiert.

Vor einer produktiven Aktivierung müssen zusätzlich umgesetzt und getestet sein:

- automatische tägliche Ausführung,
- bounded retention mit Standard 30 Backups,
- Restore-Verifikation und Privacy-Reconciliation, bevor wiederhergestellte Daten nutzbar werden,
- Audit-/Statusnachweis erfolgreicher und fehlgeschlagener Backup-/Restore-Läufe.

Erst dann darf die Runtime-Attestation auf `PRIVACY_BACKUP_STATE=ENABLED` mit Policy-Version `1.0.0` umgestellt werden.

## Nicht in Backups einbetten

Der Backup-Schlüssel selbst und unverschlüsselte Produktivdaten dürfen nicht in dieses Repository oder in das Backup-Bundle eingebettet werden. Host-Secrets wie `.env` benötigen einen separaten sicheren Wiederherstellungsweg.
