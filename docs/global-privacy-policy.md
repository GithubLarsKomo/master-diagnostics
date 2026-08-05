# Globale Privacy-Capability-Verträge

## Zweck

Backup-/Restore- und Notification-Speicher liegen außerhalb eines einzelnen Athleten-Row-Scope. Ihre Datenschutzkonformität kann deshalb nicht aus `getAthleteAnonymizationPreview()` allein abgeleitet werden.

Policy v1.4 führt dafür eine explizite Laufzeit-Attestation ein. Fehlende Angaben werden **nicht** als deaktivierte Funktion interpretiert, sondern blockieren irreversible Verarbeitung.

## Backup Privacy Policy v1.0.0

Ein Backup-System muss seinen Zustand explizit als `DISABLED` oder `ENABLED` deklarieren.

Bei `ENABLED` sind zwingend erforderlich:

- Policy-Version `1.0.0`,
- Verschlüsselung der Backup-Daten im Ruhezustand,
- konfigurierte, begrenzte Backup-Aufbewahrung,
- Privacy-Reconciliation bei Restore **bevor** wiederhergestellte Daten produktiv verwendet werden.

Der Restore-Vertrag ist entscheidend: Ein älteres Backup darf einen bereits vollzogenen Lösch-/Anonymisierungszustand nicht dauerhaft wieder einführen. Die konkrete Backup-/Restore-Implementierung in Epic 12 muss deshalb einen Mechanismus bereitstellen, der nach Restore die seit dem Backup wirksam gewordenen Privacy-Maßnahmen erneut anwendet oder die produktive Freigabe verhindert.

Die Policy schreibt bewusst keine willkürliche Backup-Retentionsdauer fest. Die Betriebsimplementierung muss eine begrenzte Dauer konfigurieren und dokumentieren; unbefristete Backup-Aufbewahrung erfüllt den Vertrag nicht.

## Notification Privacy Policy v1.0.0

Auch Notifications müssen explizit `DISABLED` oder `ENABLED` deklarieren.

Bei `ENABLED` sind zwingend erforderlich:

- Policy-Version `1.0.0`,
- ein deterministischer Subject-Scope für athletenbezogene Notification-Payloads,
- Verbot direkter Identifikatoren in Notification-Payloads,
- gezielter Cleanup aller Notifications eines betroffenen Athleten vor irreversibler Verarbeitung.

Die bestehende generische `payload_json`-Tabelle allein erfüllt diesen Vertrag noch nicht. Eine spätere Notification-Implementierung muss den Subject-Vertrag technisch erzwingen, bevor sie als `ENABLED` attestiert werden darf.

## Fail-closed Attestation

`evaluateGlobalPrivacyCapabilities()` unterscheidet drei praktisch relevante Zustände:

1. **nicht deklariert** → blockierend,
2. **explizit DISABLED** → kein externer Datenspeicher vorhanden, Gate erfüllt,
3. **ENABLED** → nur bei vollständig erfülltem versionsgebundenem Capability-Vertrag zulässig.

Eine teilweise erfüllte Capability wird nicht akzeptiert. Jeder fehlende Bestandteil wird als eigener strukturierter Blocker ausgewiesen.

`resolveGlobalPrivacyCapabilitiesFromEnvironment()` bildet diesen Vertrag auf explizite Runtime-Konfiguration ab. Unbekannte Zustands- oder Boolean-Werte werden nicht coerced, sondern als Konfigurationsfehler verworfen. Fehlende Werte bleiben fehlend und werden vom Evaluator blockierend behandelt.

### Environment-Vertrag

Backup:

- `PRIVACY_BACKUP_STATE=DISABLED|ENABLED`
- bei `ENABLED`: `PRIVACY_BACKUP_POLICY_VERSION=1.0.0`
- bei `ENABLED`: `PRIVACY_BACKUP_ENCRYPTED_AT_REST=true`
- bei `ENABLED`: `PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED=true`
- bei `ENABLED`: `PRIVACY_BACKUP_RESTORE_RECONCILIATION=true`

Notifications:

- `PRIVACY_NOTIFICATIONS_STATE=DISABLED|ENABLED`
- bei `ENABLED`: `PRIVACY_NOTIFICATIONS_POLICY_VERSION=1.0.0`
- bei `ENABLED`: `PRIVACY_NOTIFICATIONS_SUBJECT_SCOPED_PAYLOAD=true`
- bei `ENABLED`: `PRIVACY_NOTIFICATIONS_DIRECT_IDENTIFIERS_FORBIDDEN=true`
- bei `ENABLED`: `PRIVACY_NOTIFICATIONS_SUBJECT_CLEANUP_SUPPORTED=true`

`DISABLED` ist nur dann korrekt, wenn die jeweilige externe Funktion im tatsächlichen Deployment nicht betrieben wird. Sobald etwa tägliche Backups produktiv aktiviert sind, muss `PRIVACY_BACKUP_STATE=ENABLED` gesetzt werden und der reale Backup-/Restore-Prozess alle vier versionsgebundenen Kontrollanforderungen erfüllen.

## Deployment-Preflight

`pnpm privacy-capabilities:check` liest ausschließlich diesen Environment-Vertrag, bewertet ihn mit derselben Policy und gibt eine PII-/Secret-freie Zusammenfassung aus:

- `readyForIrreversibleProcessing`,
- deklarierte Backup-/Notification-Zustände,
- erwartete Policy-Versionen,
- strukturierte Blocker.

Bei nicht erfülltem Vertrag endet das Kommando mit Exit-Code ungleich `0`.

Im Club-Compose läuft dieser Check als einmaliger `privacy-check`-Service. Die Web-App hängt von dessen erfolgreichem Abschluss ab. Damit kann ein Deployment mit fehlender oder unvollständiger globaler Privacy-Attestation nicht unbemerkt als betriebsbereit starten.

`executeConfiguredAthleteAnonymization()` verwendet denselben Environment-Resolver. Selbst außerhalb des Compose-Preflights scheitert der produktionsorientierte irreversible Einstieg daher vor DB-/Dateimutationen, wenn die Attestation nicht bereit ist.

## Verhältnis zur Anonymisierungs-Policy

Policy v1.4.0 übersetzt die früheren globalen Review-Punkte in zwei konkrete Anforderungen:

- `BACKUP_PRIVACY_POLICY_V1`,
- `NOTIFICATION_PRIVACY_POLICY_V1`.

Sind die benötigten Capabilities nicht attestiert, bleibt `GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED` aktiv. Bei erfolgreicher Attestation entfällt nur dieser Blocker; `ADMINISTRATIVE_APPROVAL_REQUIRED` bleibt bestehen und `executionAllowed` weiterhin `false`.

Damit ist der fachliche Policy-Vertrag definiert und produktiv fail-closed verdrahtet, ohne einen nicht vorhandenen Backup-/Notification-Workflow vorzutäuschen. Die tatsächliche Aktivierung einer globalen Funktion darf erst nach technischer Umsetzung ihrer jeweiligen Policy-Anforderungen attestiert werden.
