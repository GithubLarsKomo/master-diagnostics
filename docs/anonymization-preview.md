# Read-only Anonymisierungs-Preview

## Zweck

`getAthleteAnonymizationPreview()` erzeugt vor jeder späteren irreversiblen Verarbeitung eine tenantgebundene, deterministische und vollständig read-only Übersicht der Datenklassen, die für einen Athleten behandelt werden müssen.

Die Preview ist **keine Ausführungsfreigabe**. Sie kombiniert den bestehenden irreversiblen Precheck mit einem Scope-Inventar. Die Preview selbst bleibt neutral; die versionierte Policy legt fest, wie die einzelnen Risikoklassen behandelt werden.

## Erfasste Datenklassen

Die Preview weist getrennt aus:

- aktuelles Athletenprofil,
- unveränderliche Athleten-Snapshots,
- Testplan-Snapshots,
- Coach-Zuordnungen,
- Einwilligungsnachweise,
- Guardian-Datensätze,
- Löschworkflow-Datensätze,
- Test-, Mess-, Qualitäts-, Korrektur-, Schwellen-, Ergebnis-, Interpretations- und Zonen-Daten,
- persistierte Report-Datensätze samt `storage_reference`,
- noch offene historische Audit-Privacy-Kandidaten und bereits vorhandene Redaktionsnachweise,
- aktive Tenant-Exportpakete als mögliche noch erreichbare identifierhaltige Artefakte.

Zusätzlich werden globale Anforderungen ausgewiesen: Report-Storage-Verifikation, Backup-Retention und Notification-Payload-Prüfung. Die Policy übersetzt diese Hinweise in konkrete Dispositionen bzw. versionierte Runtime-Capability-Verträge.

## Dispositions statt vorweggenommener Löschregeln

Die Preview klassifiziert Datenklassen mit einer erforderlichen Behandlung, ohne einen Writer zu simulieren:

- `DIRECT_IDENTIFIER_REDACTION_REQUIRED`
- `EMBEDDED_IDENTIFIER_REWRITE_REQUIRED`
- `RELATIONSHIP_LINK_REMOVAL_REQUIRED`
- `MINIMIZED_COMPLIANCE_RECORD_REQUIRED`
- `THIRD_PARTY_RECORD_REMOVAL_REQUIRED`
- `FREE_TEXT_REDACTION_REQUIRED`
- `REIDENTIFICATION_RISK_REVIEW_REQUIRED`
- `EXTERNAL_ARTIFACT_HANDLING_REQUIRED`
- `AUDIT_PRIVACY_REDACTION_REQUIRED`
- `EPHEMERAL_EXPORT_CLEANUP_REQUIRED`

Policy v1.2 löst das Diagnostik-Risiko konservativ durch spätere Löschung detaillierter individueller Diagnostik-/Verlaufsdaten und historischer Snapshots auf.

Policy v1.3 löst zusätzlich die externen row-level Artefakte auf: Report-PDF und zugehörige Report-Datenbankzeile werden gemeinsam entfernt; aktive vollständige Tenant-Exportpakete werden vor der irreversiblen Verarbeitung tenantweit entfernt.

Policy v1.4 übersetzt die globalen Backup-/Notification-Hinweise in `BACKUP_PRIVACY_POLICY_V1` und `NOTIFICATION_PRIVACY_POLICY_V1`. Ob diese Verträge im konkreten Betrieb erfüllt sind, wird nicht aus der Preview geraten, sondern über `evaluateGlobalPrivacyCapabilities()` explizit attestiert. Fehlende Angaben bleiben blockierend.

## Sicherheitsgrenzen

- ausschließlich `SELECT`-Zugriffe in der Scope-Ermittlung,
- Tenant-Isolation in allen athleten- und testbezogenen Abfragen,
- keine Ausgabe von Namen, Geburtsdatum oder anderen direkten Identifikatoren,
- keine Datei-Löschung oder Veränderung von `storage_reference`,
- keine Audit-Redaktion; dafür bleibt ausschließlich der kontrollierte Privacy-Maintenance-Pfad zuständig,
- keine automatische Verarbeitung aktiver Exportpakete,
- keine implizite Annahme, dass nicht deklarierte Backup-/Notification-Funktionen deaktiviert sind,
- `passesIrreversiblePrecheck = true` ist weiterhin nur eine notwendige Vorbedingung.

## Nächste Gates

Mit Policy v1.4 sind alle derzeit bekannten row-level und globalen Datenschutzregeln versioniert definiert. Vor einer Ausführung müssen die benötigten globalen Capabilities zur Laufzeit erfolgreich attestiert werden. Danach bleibt als eigener nächster Fachslice die explizite administrative Ausführungsfreigabe; erst anschließend darf ein atomarer irreversibler Writer implementiert werden.
