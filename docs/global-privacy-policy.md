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

## Verhältnis zur Anonymisierungs-Policy

Policy v1.4.0 übersetzt die früheren globalen Review-Punkte in zwei konkrete Anforderungen:

- `BACKUP_PRIVACY_POLICY_V1`,
- `NOTIFICATION_PRIVACY_POLICY_V1`.

Sind die benötigten Capabilities nicht attestiert, bleibt `GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED` aktiv. Bei erfolgreicher Attestation entfällt nur dieser Blocker; `ADMINISTRATIVE_APPROVAL_REQUIRED` bleibt bestehen und `executionAllowed` weiterhin `false`.

Damit ist der fachliche Policy-Vertrag definiert, ohne einen nicht vorhandenen Backup-/Notification-Workflow vorzutäuschen oder den irreversiblen Writer vorzeitig freizugeben.
