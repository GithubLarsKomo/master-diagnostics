# Backup Privacy Activation Readiness v1

## Zweck

Dieses Gate liegt bewusst **zwischen** dem realen Restore-/RTO-Drill und einer späteren manuellen Aktivierung der Backup-Privacy-Capability.

Es beantwortet nur die technische Frage:

> Liegt ein kryptografisch verifizierter, auf dem Host erfolgreich abgeschlossener Restore-/RTO-Drill vor, der die in der Backup Privacy Policy geforderten Restore-Sicherheitsmerkmale praktisch nachweist?

Es ändert keine Konfiguration und aktiviert keine Capability.

Bis zu einem realen erfolgreichen Drill bleibt:

```text
PRIVACY_BACKUP_STATE=DISABLED
```

## Befehl

Nach einem tatsächlich auf dem vorgesehenen Club-Host durchgeführten Drill:

```bash
bash infra/backup/check-club-backup-privacy-activation-readiness.sh \
  /var/lib/master-diagnostics/restore-rto-drills/drill-<32-hex>.json
```

Der Report muss innerhalb von `RESTORE_RTO_DRILL_REPORT_HOST_DIR` liegen. Der Wrapper akzeptiert weder Symlinks noch Reports außerhalb dieses Roots.

## Verifikationskette

Der Checker liest ausschließlich:

- den signierten Drill-Report,
- den unabhängigen RTO-Drill-HMAC-Key,
- den aktuellen `PRIVACY_BACKUP_STATE` aus der bereits geladenen Umgebung.

Er prüft erneut:

1. kanonischen Report-Dateinamen und sichere Dateirechte,
2. Envelope-/Record-Version,
3. `reportFingerprint`,
4. HMAC-SHA256 unter `masters:restore-rto-drill-report:v1`,
5. Host-Operational-Scope,
6. Gesamtstatus `COMPLETED`,
7. RTO-Ziel 14.400 Sekunden und `rtoMet=true`,
8. vollständige achtphasige Drill-Sequenz,
9. jede Phase `COMPLETED` mit Exit-Code `0`,
10. erfolgreich enthaltene `PRIVACY_REPLAY`-Phase,
11. erfolgreich enthaltene kontrollierte Promotion bis `EXECUTE_SWITCH`,
12. dass der Drill-Report selbst weiterhin `privacyBackupActivationAllowed=false` trägt.

Die letzte Prüfung schützt die Governance-Grenze: Ein Drill-Report ist Evidenz, keine Aktivierungsautorisierung.

## Status

### `BLOCKED`

Beispiele für Blocker:

- Report-HMAC oder Fingerprint stimmt nicht,
- Drill war nicht `COMPLETED`,
- RTO-Ziel wurde verfehlt,
- Privacy-Reconciliation oder kontrollierte Promotion wurde nicht erfolgreich durchlaufen,
- eine Phase fehlt oder endete nicht erfolgreich,
- `PRIVACY_BACKUP_STATE` wurde bereits vor Abschluss der Readiness-Prüfung auf `ENABLED` gestellt.

Der letzte Fall ist absichtlich fail-closed. Ein bereits aktivierter Zustand darf nicht nachträglich durch einen Readiness-Check legitimiert werden.

### `READY_FOR_MANUAL_ATTESTATION`

Dieser Status bedeutet nur, dass die technische Drill-Evidence für den nächsten Governance-Schritt ausreichend ist.

Die Ausgabe nennt als **Zielkonfiguration**, nicht als automatisch gesetzte Konfiguration:

```dotenv
PRIVACY_BACKUP_STATE=ENABLED
PRIVACY_BACKUP_POLICY_VERSION=1.0.0
PRIVACY_BACKUP_ENCRYPTED_AT_REST=true
PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true
PRIVACY_BACKUP_RESTORE_RECONCILIATION=true
```

Auch im grünen Fall bleiben in der Ausgabe fest:

```text
automaticActivationPerformed=false
privacyBackupActivationAllowed=false
```

Ein separater späterer Aktivierungs-Slice muss daher die reale Betriebsfreigabe und den Runtime-Attestation-Wechsel explizit behandeln.

## Warum kein automatisches Umschalten?

Die technische Kette beweist, dass ein konkreter Restore auf der Zielumgebung funktioniert hat. Sie beweist nicht automatisch, dass organisatorische Voraussetzungen, Wartungs-/Backup-Betrieb, Schlüsselverwaltung und Betriebsverantwortung formal akzeptiert wurden.

Deshalb trennt Epic 12 weiterhin:

1. technische Restore-Fähigkeit,
2. signierte praktische Drill-Evidence,
3. read-only Aktivierungs-Readiness,
4. spätere explizite Capability-Attestation.

## CI-Grenze

Der CI-Contract erzeugt einen echten HMAC-signierten Drill-Report mit dem bestehenden Report-Writer und prüft:

- erfolgreichen Readiness-Fall,
- HMAC-/Fingerprint-Tampering,
- fehlgeschlagenen/zu langsamen Drill,
- vorzeitiges `PRIVACY_BACKUP_STATE=ENABLED`,
- read-only Host-/Checker-Grenze,
- weiterhin offene `TASKS.md`-/Release-Gates und `PRIVACY_BACKUP_STATE=DISABLED` in `.env.example`.

Ein grüner CI-Lauf ersetzt ausdrücklich **nicht** den realen Host-Drill.
