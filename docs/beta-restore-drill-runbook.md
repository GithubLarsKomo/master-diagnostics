# Beta Restore Drill Runbook

Dieses Runbook beschreibt den praktischen Host-Nachweis für das Beta-Release-Gate `Backup und Restore praktisch getestet wurden`.

## Voraussetzungen

- realer oder produktionsnaher Club-Host mit Testdaten,
- Deployment exakt aus einem dokumentierten Git-Commit,
- `.env` vollständig für Backup/Restore konfiguriert,
- Restore-RTO-Report-Key vorhanden und Modus `0600`,
- verschlüsseltes Backup mit `.sha256`-Sidecar im konfigurierten Backup-Verzeichnis,
- keine produktiven personenbezogenen Echtdaten für den Drill verwenden.

## 1. Deployment und Ausgangszustand dokumentieren

```bash
hostname

git rev-parse HEAD

docker compose ps
```

Vor dem Restore notieren bzw. sichern:

- Host-Identifier,
- vollständige Commit-SHA,
- vorhandene produktive Volumes,
- Caddy-/TLS-Zustand,
- mindestens eine bekannte Athleten-/Test-/Report-Stichprobe, die nach dem Restore wiederzufinden sein muss.

## 2. Backup erzeugen und verifizieren

Backup ausschließlich über die produktive Backup-Kette erzeugen. Danach Bundle-Namen und SHA-256 erfassen und die vorhandene unabhängige Verifikation ausführen.

```bash
bash infra/backup/verify-club-backup.sh masters-backup-<timestamp>-<uuid>.mdbak
sha256sum /var/backups/master-diagnostics/masters-backup-<timestamp>-<uuid>.mdbak
```

Der für die Evidence verwendete Fingerprint hat das Format `sha256:<64-hex>`.

## 3. Praktischen Restore-RTO-Drill ausführen

```bash
bash infra/backup/run-club-restore-rto-drill.sh masters-backup-<timestamp>-<uuid>.mdbak
```

Der Ablauf muss alle acht Phasen erfolgreich durchlaufen:

1. `VERIFY_BACKUP`
2. `STAGE_RESTORE`
3. `PRIVACY_REPLAY`
4. `AUTHORIZE_PROMOTION`
5. `PREPARE_PROMOTION_PLAN`
6. `PREPARE_CANDIDATES`
7. `AUTHORIZE_SWITCH`
8. `EXECUTE_SWITCH`

Ein fehlgeschlagener oder zurückgerollter Drill schließt das Beta-Gate nicht.

## 4. Signierten RTO-Report unabhängig prüfen

Den neu erzeugten Report unter dem konfigurierten `RESTORE_RTO_DRILL_REPORT_HOST_DIR` identifizieren und mit dem bestehenden Checker verifizieren:

```bash
python3 infra/backup/check-restore-rto-drill-report.py \
  --report /var/lib/master-diagnostics/restore-rto-drills/drill-<id>.json \
  --key-file /etc/master-diagnostics/restore-rto-drill-report.key \
  --expected-bundle-name masters-backup-<timestamp>-<uuid>.mdbak \
  --expected-bundle-sha256 sha256:<64-hex> \
  --require-completed \
  --require-rto-met
```

Erforderlich sind insbesondere:

- `drillStatus = COMPLETED`,
- `rtoMet = true`,
- `privacyReconciliationIncluded = true`,
- `controlledPromotionIncluded = true`,
- `practicalRestoreEvidenceVerified = true`.

## 5. Betriebsnachweise nach Promotion

Nach dem Restore müssen zusätzlich manuell geprüft und dokumentiert werden:

- HTTPS-/App-Healthcheck erfolgreich,
- Login und realer Trainer-Lesepfad erfolgreich,
- bekannte Athleten-/Test-/Report-Stichprobe vollständig vorhanden,
- Caddy-/TLS-Zustand erhalten,
- keine unerwarteten produktiven Volumes verloren oder ersetzt,
- keine offenen Abweichungen.

## 6. Operator-Evidence anlegen

Eine JSON-Datei mit exakt diesem Schema anlegen:

```json
{
  "evidenceVersion": 1,
  "hostId": "club-host-01",
  "deploymentCommitSha": "0123456789abcdef0123456789abcdef01234567",
  "bundleName": "masters-backup-<timestamp>-<uuid>.mdbak",
  "bundleFingerprint": "sha256:<64-hex>",
  "rtoReportPath": "/var/lib/master-diagnostics/restore-rto-drills/drill-<id>.json",
  "healthcheckPassed": true,
  "trainerReadPathPassed": true,
  "sampleDataPassed": true,
  "caddyPreserved": true,
  "unexpectedVolumeLoss": false,
  "deviations": []
}
```

Die Datei soll nach Abschluss read-only archiviert werden; sie enthält keine Diagnostik- oder personenbezogenen Nutzdaten.

## 7. Beta-Evidence fail-closed verifizieren

```bash
python3 infra/backup/check-beta-restore-drill-evidence.py \
  --evidence /absolute/path/beta-restore-drill-evidence.json \
  --rto-key-file /etc/master-diagnostics/restore-rto-drill-report.key
```

Nur wenn der Checker `"betaRestoreGateReady":true` ausgibt, darf die praktische Restore-Evidence als technisch vollständig betrachtet werden. Das Repo-Release-Gate wird anschließend zusammen mit dem archivierten Nachweis und der manuellen WCAG-Abnahme geschlossen.

## Abbruchkriterien

Gate bleibt offen bei:

- fehlendem oder ungültigem signierten RTO-Report,
- RTO > 4 Stunden,
- fehlender Privacy-Reconciliation oder Promotion,
- fehlgeschlagenem HTTPS-/Trainer-Lesepfad,
- fehlender Datenstichprobe,
- Caddy-/TLS-Verlust,
- unerwartetem Volume-Verlust,
- irgendeiner ungelösten Abweichung.
