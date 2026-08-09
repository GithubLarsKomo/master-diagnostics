# Backup Privacy Manual Attestation v1

## Zweck

Diese Stufe liegt zwischen dem read-only Readiness-Gate aus #221 und einer späteren tatsächlichen Runtime-Aktivierung der Backup-Privacy-Capability.

Sie erzeugt eine **signierte, unveränderliche manuelle Betriebsfreigabe**, ändert aber noch keine `.env`, startet keine Container neu und setzt `PRIVACY_BACKUP_STATE` nicht auf `ENABLED`.

Bis zum späteren Aktivierungs-Slice bleibt daher weiterhin:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

## Voraussetzungen

Eine Attestation darf auf der vorgesehenen Club-Installation nur erzeugt werden, wenn:

1. ein echter Host-Restore-/RTO-Drill gemäß #220 erfolgreich abgeschlossen wurde,
2. dessen signierter Report durch #221 erneut `READY_FOR_MANUAL_ATTESTATION` ergibt,
3. der reale Runtime-Zustand weiterhin `PRIVACY_BACKUP_STATE=DISABLED` ist,
4. ein Operator seine Betriebsverantwortung ausdrücklich bestätigt.

Der Writer erzwingt Punkt 3, indem er die reale Prozessumgebung an den #221-Checker weiterreicht. Er setzt `PRIVACY_BACKUP_STATE` niemals selbst auf `DISABLED`.

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
  --drill-report /var/lib/master-diagnostics/restore-rto-drills/drill-<32-hex>.json \
  --drill-key-file /etc/master-diagnostics/restore-rto-drill.key \
  --attestation-key-file /etc/master-diagnostics/backup-privacy-manual-attestation.key \
  --output-dir /var/lib/master-diagnostics/backup-privacy-attestations \
  --attestation-id attestation-<32-hex> \
  --attestor-id <technische-operator-id> \
  --attested-at 2026-08-09T12:00:00.000Z \
  --acknowledge-operational-responsibility
```

`--acknowledge-operational-responsibility` ist absichtlich zwingend. Ohne diesen expliziten Schalter wird keine Attestation erzeugt.

Der Writer führt den #221-Readiness-Checker erneut aus und akzeptiert ausschließlich:

```text
READY_FOR_MANUAL_ATTESTATION
```

mit exakt der Policy-v1-Zielkonfiguration.

## Gebundene Evidence

Der signierte Record bindet mindestens:

- `attestationId`,
- technische `attestorId`,
- `attestedAt`,
- `drillId`,
- HMAC-verifizierten `drillReportFingerprint`,
- `readinessVersion=1`,
- `readinessStatus=READY_FOR_MANUAL_ATTESTATION`,
- erfolgreiches RTO-Ziel,
- nachgewiesene Privacy-Reconciliation,
- kontrollierte Promotion,
- explizite Betriebsverantwortungsbestätigung,
- die vollständige Backup-Privacy-Policy-v1-Zielkonfiguration.

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
- keine Symlink-Datei als Schlüssel
- kanonischer Dateiname `attestation-<32-hex>.json`
- bestehende identische Attestation wird idempotent wiederverwendet
- derselbe Attestation-Identifier mit abweichendem Inhalt blockiert fail-closed

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
- #221 nicht `READY_FOR_MANUAL_ATTESTATION` ergibt,
- der reale Backup-Capability-Zustand bereits `ENABLED` ist,
- die Policy-Zielkonfiguration abweicht,
- das Operator-Acknowledgement fehlt,
- eine Attestation-ID bereits mit anderem Inhalt existiert.

Der Verifier blockiert jede Inhalts-, Fingerprint- oder HMAC-Manipulation.

## CI-Grenze

Der `Backup Privacy Manual Attestation Contract` erzeugt synthetische, aber echt HMAC-signierte Drill-Evidence und prüft die Werkzeugkette. Das ist **keine reale Betriebsfreigabe** und ersetzt weder den Host-Drill noch die spätere Operator-Attestation.

Der Contract bestätigt außerdem, dass:

- die Werkzeuge keine Docker-/Compose-Mutation enthalten,
- `.env.example` weiterhin `PRIVACY_BACKUP_STATE=DISABLED` trägt,
- die praktischen Restore-/RTO-Tasks und Release-Gates offen bleiben.

## Nächster Slice

Erst ein separater Aktivierungs-Slice darf eine **verifizierte reale** Manual-Attestation konsumieren, die Zielwerte atomar in die Runtime-Konfiguration übernehmen, die Runtime-Attestation erneut prüfen und bei jeder Abweichung fail-closed abbrechen oder zurückrollen.
