# Backup-Grundkonzept

## Aktueller Stand

Epic 12 stellt einen **verschlüsselten Full-Volume-Backup-Bundle-Pfad**, eine **tägliche hostseitige Zeitplanung mit bounded retention**, eine **read-only Restore-Verifikation** und ein **isoliertes Restore-Staging außerhalb der Produktivvolumes** bereit. Es gibt noch keine Privacy-Reconciliation und keine Freigabe bzw. Promotion eines Stagings in die Produktivinstanz. Der Stand rechtfertigt deshalb noch **nicht** `PRIVACY_BACKUP_STATE=ENABLED`.

Verbindliche Ziele aus SPEC §40:

- tägliches konsistentes Backup,
- Verschlüsselung vor Ablage,
- 30 tägliche Sicherungen als Standard,
- lokales/NAS-Ziel, optional später S3-kompatibel,
- Integritätsprüfung,
- dokumentierter und protokollierter Restore-Test,
- RPO maximal 24 Stunden und RTO-Ziel 4 Stunden.

## Warum Clean-Shutdown statt Live-Volume-Kopie?

libSQL verwendet WAL-/Replikationszustand im persistenten Datenverzeichnis. Eine laufende Docker-Volume-Kopie würde daher eine Konsistenzbehauptung machen, die das Backup-System nicht garantieren kann.

`infra/backup/create-club-backup.sh` verwendet deshalb eine konservative Grenze:

1. der Backup-Helper wird vor Beginn der Downtime gebaut,
2. Caddy, Web-App und Maintenance-Writer werden beendet,
3. libSQL wird anschließend mit erweitertem Shutdown-Timeout sauber beendet,
4. erst dann werden die persistenten Volumes read-only in den Backup-Helper eingebunden,
5. der Helper streamt ein Tar-Archiv direkt durch AES-256-GCM in das Backup-Ziel,
6. nach erfolgreicher Bundle-Erzeugung werden ausschließlich ältere **vollständige** Backup-/Sidecar-Paare über der konfigurierten Retention entfernt,
7. nach Erfolg oder Fehler wird der reguläre Club-Stack wieder gestartet.

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

## Schlüssel, Ziel und Retention vorbereiten

Der Backup-Schlüssel muss **getrennt vom Backup-Ziel** gesichert werden. Er darf weder in Git noch gemeinsam mit den verschlüsselten Bundles abgelegt werden.

Beispiel auf dem Club-Host:

```bash
sudo install -d -m 700 /etc/master-diagnostics
openssl rand -base64 32 | sudo tee /etc/master-diagnostics/backup.key >/dev/null
sudo chmod 600 /etc/master-diagnostics/backup.key

sudo install -d -m 700 /var/backups/master-diagnostics
sudo install -d -m 700 /var/lib/master-diagnostics/restore-staging
```

In `.env`:

```dotenv
BACKUP_HOST_DIR=/var/backups/master-diagnostics
BACKUP_KEY_FILE=/etc/master-diagnostics/backup.key
BACKUP_RETENTION_COUNT=30
RESTORE_STAGING_HOST_DIR=/var/lib/master-diagnostics/restore-staging
```

Das Key-File muss Base64 enthalten, das exakt 32 Byte entschlüsselt. `BACKUP_RETENTION_COUNT` akzeptiert 1 bis 365; Standard ist 30.

Die Retention zählt nur streng benannte, vollständige `.mdbak` + `.mdbak.sha256`-Paare. Orphaned Bundles oder Sidecars werden **nicht** automatisch gelöscht und zählen nicht als vollständige Sicherung; der Backup-Output meldet deren Anzahl zur operativen Prüfung. Gepruned wird nur nach erfolgreicher Erzeugung des neuen verschlüsselten Bundles. Beim Entfernen eines alten Paars wird zuerst das sensible Bundle gelöscht; ein möglicher Sidecar-Rest enthält keine Fachdaten.

## Manuellen Bundle-Lauf ausführen

Vom Repository aus:

```bash
bash infra/backup/create-club-backup.sh
```

Der Lauf benötigt `docker`, Docker Compose v2 und `flock` auf dem Host. Ein exklusiver Lock verhindert parallele Backup-Läufe.

Ein erfolgreicher Lauf erzeugt ausschließlich ein neues Paar:

```text
masters-backup-<timestamp>-<uuid>.mdbak
masters-backup-<timestamp>-<uuid>.mdbak.sha256
```

`.mdbak` ist AES-256-GCM-verschlüsselt. Das Klartext-Tar wird nicht auf das Backup-Ziel geschrieben. Die `.sha256`-Datei dient als schneller Transport-/Dateiintegritätscheck; die GCM-Authentifizierung schützt zusätzlich den entschlüsselten Inhalt gegen Manipulation.

Die JSON-Ausgabe des Helpers enthält außerdem den Retention-Nachweis mit konfiguriertem Limit, vollständigen Paaren vor dem Prune, behaltenen/geprunten Paaren und Orphan-Zählern.

## Tägliche Zeitplanung installieren

Der tägliche Lauf wird absichtlich **auf dem Host** geplant. Ein Scheduler-Container müsste zum Stoppen/Starten des Stacks Docker-Socket-Rechte erhalten und würde die Sicherheitsgrenze unnötig erweitern.

Nach vollständig konfigurierter `.env`:

```bash
sudo bash infra/backup/install-club-backup-timer.sh
```

Der Installer erzeugt:

- `master-diagnostics-backup.service` als `Type=oneshot`, der exakt `infra/backup/create-club-backup.sh` aus diesem Checkout aufruft,
- `master-diagnostics-backup.timer` mit `OnCalendar=*-*-* 03:00:00` und `Persistent=true`.

`Persistent=true` sorgt dafür, dass ein während ausgeschaltetem Host verpasster Lauf nach dem nächsten Start nachgeholt wird. Der bestehende `flock`-Schutz verhindert trotzdem parallele Backup-Läufe.

Kontrolle:

```bash
systemctl status master-diagnostics-backup.timer
systemctl list-timers master-diagnostics-backup.timer
journalctl -u master-diagnostics-backup.service
```

Zum Entfernen:

```bash
sudo systemctl disable --now master-diagnostics-backup.timer
sudo rm -f /etc/systemd/system/master-diagnostics-backup.timer \
  /etc/systemd/system/master-diagnostics-backup.service
sudo systemctl daemon-reload
```

Der Installer verlangt einen Repository-Pfad ohne Whitespace oder `%`, damit der generierte systemd-Vertrag eindeutig bleibt.

## Backup vor einem Restore verifizieren

Die Verifikation benötigt **keine Downtime** und hat keinen Schreibzugriff auf Produktivvolumes oder das Backup-Ziel. Sie prüft in dieser Reihenfolge:

1. Sidecar-Format und Zuordnung zur ausgewählten `.mdbak`-Datei,
2. SHA-256 des vollständigen Bundles,
3. AES-256-GCM-Authentifizierung mit dem getrennten Backup-Schlüssel,
4. lesbare Tar-Struktur ohne unsichere/unerwartete Top-Level-Pfade,
5. exakt das Manifest-Schema der Bundle-Version 1,
6. alle sechs erwarteten Quellklassen und `restoreReconciliationRequired = true`.

Aufruf mit dem Dateinamen aus `BACKUP_HOST_DIR`:

```bash
bash infra/backup/verify-club-backup.sh masters-backup-<timestamp>-<uuid>.mdbak
```

Der Compose-Service `backup-verify` sieht das Backup-Ziel und das Key-File ausschließlich read-only. Die entschlüsselten Nutzdaten werden nicht entpackt. Temporär entsteht nur ein `0600`-Tar in einem privaten Verzeichnis des ephemeren Verifikationscontainers; dieses Verzeichnis wird vor Erfolg **und** Fehler vollständig entfernt.

Ein manipuliertes Bundle scheitert selbst dann an der GCM-Authentifizierung, wenn jemand die unverschlüsselte SHA-256-Sidecar-Datei passend neu berechnet hat.

Die erfolgreiche Verifikation bedeutet ausdrücklich **nicht**, dass ein Restore bereits freigegeben ist. Sie bestätigt nur Transportintegrität, kryptografische Authentizität und strukturelle Restore-Fähigkeit des Bundles.

## Verifiziertes Backup isoliert stagen

Der nächste Restore-Schritt schreibt weiterhin **nicht** in Produktivvolumes. Er erzeugt stattdessen aus einem verifizierten Bundle eine neue Klartextkopie in einem ausschließlich dafür vorgesehenen Staging-Verzeichnis:

```bash
bash infra/backup/stage-club-restore.sh masters-backup-<timestamp>-<uuid>.mdbak
```

Der Host-Wrapper benötigt keine Downtime. Der Compose-Service `backup-restore-stage` besitzt ausschließlich drei Mounts:

- Backup-Ziel read-only,
- Backup-Key read-only,
- `RESTORE_STAGING_HOST_DIR` read-write.

Produktive libSQL-, Report-, Export-, Betroffenenexport- oder Caddy-Volumes werden **nicht** in den Staging-Container gemountet.

Vor der Entschlüsselung wird das ausgewählte verschlüsselte Bundle samt Sidecar in ein privates temporäres Verzeichnis kopiert. Dadurch prüft und entschlüsselt der Staging-Prozess einen stabilen Snapshot und nicht eine Datei, die währenddessen am Backup-Ziel ausgetauscht werden könnte. Auf dieser privaten Kopie laufen erneut SHA-256-, AES-GCM-, Archiv- und Manifest-Verifikation.

Vor jeder Extraktion wird die verbose Tar-Struktur geprüft. Zulässig sind ausschließlich reguläre Dateien und Verzeichnisse; Symlinks, Hardlinks, Geräte, FIFOs und andere Special-Entries werden fail-closed abgelehnt. Erst danach wird mit deaktivierter Owner-/Permission-Übernahme in ein neues Verzeichnis der Form

```text
restore-<timestamp>-<uuid>/
```

extrahiert. Der Staging-Root sowie der neue Restore-Ordner werden mit `0700` geschützt. Nach der Extraktion werden die sechs erwarteten Quellverzeichnisse und `manifest.json` nochmals auf exakten Top-Level-Scope und Dateityp geprüft. Bei einem Fehler wird das neu angelegte Staging vollständig entfernt; temporäre entschlüsselte Tar-Daten werden immer gelöscht.

**Wichtig:** Das erfolgreiche Staging ist noch kein freigegebener Restore. Die dort liegenden Daten sind entschlüsselte personenbezogene Produktivdaten und müssen wie Produktivdaten geschützt werden. Sie dürfen weder von der App noch von libSQL produktiv verwendet werden, solange Privacy-Reconciliation, Datenbank-/Anwendungsprüfung und ein expliziter Promotionsschritt nicht erfolgreich abgeschlossen sind. Nicht mehr benötigte Stagings müssen kontrolliert entfernt werden.

## Datenschutzgrenze

Ein Backup kann ältere, inzwischen gelöschte oder anonymisierte Fachdaten enthalten. Deshalb bleibt die globale Backup-Capability vorerst `DISABLED`, obwohl Bundle-Erstellung, tägliche Zeitplanung, bounded retention, read-only Verifikation und isoliertes Restore-Staging technisch existieren.

Vor einer produktiven Privacy-Attestation müssen zusätzlich umgesetzt und getestet sein:

- Privacy-Reconciliation des isolierten Stagings gegen inzwischen ausgeführte Lösch-/Anonymisierungszustände vor jeder Freigabe,
- Health-/Integritätsprüfung der wiederhergestellten Datenbank und Anwendung,
- expliziter kontrollierter Promotions-/Rückschreibepfad in Produktivvolumes,
- Audit-/Statusnachweis erfolgreicher und fehlgeschlagener Backup-/Restore-Läufe,
- praktischer Restore-/RTO-Drill.

Erst dann darf die Runtime-Attestation auf `PRIVACY_BACKUP_STATE=ENABLED` mit Policy-Version `1.0.0` umgestellt werden.

## Nicht in Backups einbetten

Der Backup-Schlüssel selbst und unverschlüsselte Produktivdaten dürfen nicht in dieses Repository oder in das Backup-Bundle eingebettet werden. Host-Secrets wie `.env` benötigen einen separaten sicheren Wiederherstellungsweg.
