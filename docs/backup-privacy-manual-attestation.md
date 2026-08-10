# Backup Privacy Manual Attestation v1

## Zweck

Diese Stufe liegt zwischen dem read-only Readiness-Gate und einer späteren tatsächlichen Runtime-Aktivierung der Backup-Privacy-Capability.

Sie erzeugt eine **signierte, unveränderliche manuelle Betriebsfreigabe**, ändert aber noch keine Runtime-Konfiguration, startet keine Container neu und setzt `PRIVACY_BACKUP_STATE` nicht auf `ENABLED`.

Bis zum späteren Aktivierungs-Slice bleibt daher weiterhin:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

## Voraussetzungen

Eine Attestation darf auf der vorgesehenen Club-Installation nur erzeugt werden, wenn:

1. ein echter Host-Restore-/RTO-Drill erfolgreich abgeschlossen wurde,
2. dessen signierter Report durch den **kanonischen unabhängigen RTO-Verifier** geprüft wurde,
3. der Report noch an die tatsächlich vorhandenen Backup-Bytes gebunden ist,
4. der Readiness-Checker `READY_FOR_MANUAL_ATTESTATION` ergibt,
5. der reale Runtime-Zustand weiterhin `PRIVACY_BACKUP_STATE=DISABLED` ist,
6. ein Operator seine Betriebsverantwortung ausdrücklich bestätigt.

Der Writer erzwingt die Byte-Bindung selbst: Er erhält das konkrete `.mdbak`, berechnet dessen SHA-256 erneut und übergibt Bundle-Name und Fingerprint an den Readiness-Checker. Er übernimmt **keinen** Bundle-Hash blind aus dem Drill-Report.

## Signaturdomäne

Die Attestation verwendet einen separaten 32-Byte-HMAC-Schlüssel und die Domain:

```text
masters:backup-privacy-manual-attestation:v1
```

Der Schlüssel soll getrennt vom RTO-Drill-Key verwaltet werden.

## Writer

```bash
PRIVACY_BACKUP_STATE=DISABLED \
python3 infra/backup/write-backup-privacy-manual-attestation.py \
  --readiness-checker "$PWD/infra/backup/check-backup-privacy-activation-readiness.py" \
  --report-verifier "$PWD/infra/backup/check-restore-rto-drill-report.py" \
  --drill-report /var/lib/master-diagnostics/restore-rto-drills/drill-<32-hex>.json \
  --drill-key-file /etc/master-diagnostics/restore-rto-drill-report.key \
  --backup-bundle /var/backups/master-diagnostics/masters-backup-<timestamp>-<uuid>.mdbak \
  --attestation-key-file /etc/master-diagnostics/backup-privacy-manual-attestation.key \
  --output-dir /var/lib/master-diagnostics/backup-privacy-attestations \
  --attestation-id attestation-<32-hex> \
  --attestor-id <technische-operator-id> \
  --attested-at 2026-08-09T12:00:00.000Z \
  --acknowledge-operational-responsibility
```

`--acknowledge-operational-responsibility` ist absichtlich zwingend. Ohne diesen expliziten Schalter wird keine Attestation erzeugt.

Vor dem Schreiben der Attestation führt der Writer den Readiness-Checker erneut aus und verlangt gleichzeitig:

```text
READY_FOR_MANUAL_ATTESTATION
canonicalDrillReportVerification=true
bundleBytesBound=true
practicalRestoreEvidenceVerified=true
currentPrivacyBackupState=DISABLED
```

Der Writer setzt `PRIVACY_BACKUP_STATE` niemals selbst auf `DISABLED` und verändert das Backup-Bundle nicht.

## Gebundene Evidence

Der signierte Record bindet weiterhin das stabile Attestation-v1-Schema:

- `attestationId`,
- technische `attestorId`,
- `attestedAt`,
- `drillId`,
- kanonisch verifizierten `drillReportFingerprint`,
- `readinessVersion=1`,
- `readinessStatus=READY_FOR_MANUAL_ATTESTATION`,
- erfolgreiches RTO-Ziel,
- nachgewiesene Privacy-Reconciliation,
- kontrollierte Promotion,
- explizite Betriebsverantwortungsbestätigung,
- die vollständige Backup-Privacy-Policy-v1-Zielkonfiguration.

Die konkrete Bundle-Bindung steckt bereits kryptografisch im `drillReportFingerprint`; zusätzlich wird beim **Erzeugen** der Attestation nachgewiesen, dass die aktuellen Bundle-Bytes noch exakt zu diesem Report gehören. So bleibt das Attestation-v1-Format kompatibel, während die Eingangsprüfung strenger wird.

Die Zielkonfiguration lautet:

```dotenv
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
```

Diese Werte sind **nur Zielzustand innerhalb der Attestation**. Der Writer schreibt sie nicht in die Laufzeitkonfiguration.

## Dateisicherheit und Retry

- Attestation-Verzeichnis: `0700`
- Attestation-Datei: `0600`
- keine Symlink-Datei als Schlüssel oder Backup-Bundle
- kanonischer Dateiname `attestation-<32-hex>.json`
- bestehende identische Attestation wird idempotent wiederverwendet
- derselbe Attestation-Identifier mit abweichendem Inhalt blockiert fail-closed

Ein fehlendes, ersetztes oder unter anderem Namen übergebenes Backup-Bundle kann die Readiness nicht passieren.

## Verifier

```bash
python3 infra/backup/check-backup-privacy-manual-attestation.py \
  --attestation /var/lib/master-diagnostics/backup-privacy-attestations/attestation-<32-hex>.json \
  --key-file /etc/master-diagnostics/backup-privacy-manual-attestation.key
```

Der Verifier prüft:

- sichere Datei und Berechtigungen,
- Envelope-/Record-Version,
- Attestation-ID und technische Attestor-ID,
- Drill-/Readiness-Bindung,
- vollständige Policy-v1-Zielkonfiguration,
- `attestationFingerprint`,
- HMAC-SHA256 unter der separaten Attestation-Domain.

Nur dann liefert er:

```text
ATTESTATION_VERIFIED
privacyBackupActivationAllowed=true
runtimeConfigurationChanged=false
automaticActivationPerformed=false
```

Damit ist die Bedeutung eindeutig: Die manuelle Freigabe ist kryptografisch vorhanden, die Runtime wurde aber noch nicht verändert.

## Fail-closed Grenzen

Keine Attestation entsteht, wenn unter anderem:

- der Drill-Report oder dessen HMAC ungültig ist,
- Report und aktuelles Backup-Bundle nicht denselben Namen/Fingerprint binden,
- die praktische Restore-Evidence nicht kanonisch verifiziert ist,
- Readiness nicht `READY_FOR_MANUAL_ATTESTATION` ergibt,
- der reale Backup-Capability-Zustand bereits `ENABLED` ist,
- die Policy-Zielkonfiguration abweicht,
- das Operator-Acknowledgement fehlt,
- eine Attestation-ID bereits mit anderem Inhalt existiert.

Der Verifier blockiert jede Inhalts-, Fingerprint- oder HMAC-Manipulation.

## CI-Grenze

Der `Backup Privacy Manual Attestation Contract` erzeugt synthetische, aber echt HMAC-signierte Drill-Evidence **und echte Test-Bundle-Bytes**. Er prüft, dass der Writer die Bundle-Datei selbst hasht und eine veränderte Datei nicht zur Attestation führen kann.

Die nachgelagerten Activation-Plan-, Execution-Evidence- und Executor-Contracts verwenden dieselbe byte-gebundene Fixture-Kette. Dadurch bleibt die stärkere Readiness-Grenze über alle späteren Artefakte erhalten.

Das ist weiterhin **keine reale Betriebsfreigabe** und ersetzt weder den Host-Drill noch die spätere Operator-Attestation.

## Nächster Schritt

Erst nach einem realen `COMPLETED`-Drill auf der Zielinstallation, unabhängiger Report-Verifikation gegen das vorhandene `.mdbak`, grünem Readiness-Check und bewusster Operator-Attestation darf die vorhandene bounded Activation-/Service-Cutover-Kette für die reale Capability-Aktivierung verwendet werden.
