# Backup Privacy Activation Readiness v1 – kanonisch gehärtet

## Zweck

Dieses Gate liegt bewusst **zwischen** dem realen Restore-/RTO-Drill und einer späteren manuellen Aktivierung der Backup-Privacy-Capability.

Es beantwortet nur die technische Frage:

> Liegt ein unabhängig verifizierter, auf dem Host erfolgreich abgeschlossener Restore-/RTO-Drill vor, dessen Report noch an exakt dieselben vorhandenen Backup-Bytes gebunden ist und der die geforderten Restore-Sicherheitsmerkmale praktisch nachweist?

Es ändert keine Konfiguration und aktiviert keine Capability. Bis zu einem realen erfolgreichen Drill bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

## Eine kanonische Report-Verifikation

Seit Restore/RTO Drill Report Verification v1 gibt es für HMAC, Report-Fingerprint, Schema, Phasenfolge, Zeitmessung und RTO nur noch eine kanonische Vertrauensinstanz:

```text
infra/backup/check-restore-rto-drill-report.py
```

`check-backup-privacy-activation-readiness.py` implementiert diese Kryptografie und das Drill-Schema **nicht erneut**. Es lädt den kanonischen Verifier und verarbeitet ausschließlich dessen normalisierte, verifizierte technische Claims.

Damit gilt:

```text
real host drill
  -> signed drill report
  -> canonical independent report verification
  -> exact current backup-byte binding
  -> activation-specific readiness policy
  -> READY_FOR_MANUAL_ATTESTATION
```

Ein späterer Schema- oder Kryptografie-Fix muss dadurch nicht in zwei konkurrierenden Checkern synchron gehalten werden.

## Host-Befehl

Nach einem tatsächlich auf dem vorgesehenen Club-Host durchgeführten Drill wird Readiness nicht mehr nur mit einem beliebigen Report-Pfad geprüft. Der Operator gibt die beiden technischen Identitäten an, die bereits im Drill zusammengehören:

```bash
bash infra/backup/check-club-backup-privacy-activation-readiness.sh \
  drill-<32-hex> \
  masters-backup-<timestamp>-<uuid>.mdbak
```

Der Wrapper:

1. löst den Report ausschließlich innerhalb `RESTORE_RTO_DRILL_REPORT_HOST_DIR` auf,
2. löst das Backup ausschließlich innerhalb `BACKUP_HOST_DIR` auf,
3. verwirft fehlende oder symlink-basierte Dateien,
4. berechnet SHA-256 der **aktuell vorhandenen Backup-Bytes** neu,
5. ruft Activation Readiness mit Report, Key, Bundle-Name und aktuellem Bundle-Fingerprint auf.

Damit kann ein historisch korrekter Drill-Report nicht gegen ein später ersetztes oder verändertes `.mdbak` als Aktivierungsnachweis dienen.

## Kanonisch verifizierte Drill-Evidence

Bevor Activation Readiness eigene Policy anwendet, muss der zentrale RTO-Verifier unter anderem erfolgreich geprüft haben:

- Report und Key mit privaten `0600`-Rechten,
- HMAC-SHA256 unter `masters:restore-rto-drill-report:v1`,
- `reportFingerprint`,
- exakte Report-v1-Struktur,
- Drill-ID und Dateinamenbindung,
- kanonische UTC-Zeitstempel und exakte Dauer,
- lückenlose operative Phasenfolge,
- Status-/Exit-Code-Konsistenz,
- RTO-Ziel 14.400 Sekunden,
- Privacy-Reconciliation und kontrollierte Promotion,
- `privacyBackupActivationAllowed=false`,
- Bundle-Name und SHA-256 gegen die aktuell erwarteten Backup-Bytes.

Nur verifizierte Claims gelangen in die Readiness-Policy.

## Aktivierungsspezifische Policy

Readiness selbst prüft danach nur noch die zusätzlichen Voraussetzungen des nächsten Governance-Schritts:

- aktueller `PRIVACY_BACKUP_STATE` ist weiterhin exakt `DISABLED`,
- `drillStatus=COMPLETED`,
- `rtoMet=true`,
- Privacy-Reconciliation ist nachgewiesen,
- kontrollierte Promotion ist nachgewiesen,
- `practicalRestoreEvidenceVerified=true`.

Fehlt eine dieser Voraussetzungen, ist der Status `BLOCKED`.

Ein bereits vor der Prüfung auf `ENABLED` gesetzter Backup-State blockiert absichtlich fail-closed. Ein Readiness-Check darf einen vorzeitig aktivierten Zustand nicht nachträglich legitimieren.

## Status `READY_FOR_MANUAL_ATTESTATION`

Der grüne Status bedeutet nur, dass die technische Drill-Evidence für den nächsten Governance-Schritt ausreichend ist. Die Ausgabe dokumentiert zusätzlich:

```text
canonicalDrillReportVerification=true
bundleBytesBound=true
practicalRestoreEvidenceVerified=true
automaticActivationPerformed=false
privacyBackupActivationAllowed=false
```

Das Ausgabeformat bleibt absichtlich `readinessVersion=1`, damit die bereits signierte Manual-Attestation-/Activation-Kette nicht wegen einer reinen Verifikationshärtung ein neues Schema benötigt.

Als **Zielkonfiguration**, nicht als automatisch gesetzte Konfiguration, wird ausgegeben:

```dotenv
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
```

## Warum kein automatisches Umschalten?

Die technische Kette beweist einen konkreten Restore auf der Zielumgebung und bindet ihn an ein konkretes Backup. Sie beweist nicht automatisch, dass organisatorische Voraussetzungen, Wartungs-/Backup-Betrieb, Schlüsselverwaltung und Betriebsverantwortung formal akzeptiert wurden.

Epic 12 trennt daher weiterhin:

1. technische Restore-Fähigkeit,
2. signierte praktische Drill-Evidence,
3. unabhängige Report-Verifikation gegen aktuelle Backup-Bytes,
4. read-only Aktivierungs-Readiness,
5. spätere explizite Capability-Attestation.

## CI-Grenze

Der CI-Contract erzeugt einen echten HMAC-signierten Drill-Report mit dem bestehenden Report-Writer und prüft:

- erfolgreichen byte-gebundenen Readiness-Fall,
- denselben Pfad über den hostseitigen Zwei-Argument-Wrapper,
- kanonisches HMAC-Tampering-Fail-closed,
- abweichende aktuelle Bundle-Bytes,
- korrekt signierte, aber fehlgeschlagene/zu langsame Drill-Evidence,
- vorzeitiges `PRIVACY_BACKUP_STATE=ENABLED`,
- dass Readiness selbst keine zweite Signing-Domain, HMAC- oder Phasenlogik enthält,
- read-only Host-/Checker-Grenze,
- weiterhin offene `TASKS.md`-/Release-Gates und `PRIVACY_BACKUP_STATE=DISABLED` in `.env.example`.

Ein grüner CI-Lauf ersetzt ausdrücklich **nicht** den realen Host-Drill. Erst reale `COMPLETED`-Evidence plus kanonische Bundle-Bindung erlaubt den manuellen Readiness-Schritt.
