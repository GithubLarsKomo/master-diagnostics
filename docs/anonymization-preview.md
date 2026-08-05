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

Die Preview-Disposition bleibt absichtlich beschreibend und versionsneutral. Die aktuelle Policy v1.5 entscheidet daraus:

- vollständige technische Minimierung des verbleibenden Athletenprofils statt bloßer Namensredaktion,
- Löschung detaillierter Diagnostik-/Verlaufsdaten und historischer Snapshots,
- gemeinsame Behandlung von Report-PDF und Report-Datenbankzeile,
- tenantweite Entfernung aktiver vollständiger Exportpakete,
- explizite Runtime-Verträge für Backup und Notifications.

Die strengere Profilregel ist erforderlich, weil auch Geburtsdatum, Körpermaße, Sport, Disziplin und Trainingsstatus Quasi-Identifikatoren sein können. Alte Approvals werden durch die Policy-Versionsbindung automatisch ungültig.

## Sicherheitsgrenzen

- ausschließlich `SELECT`-Zugriffe in der Scope-Ermittlung,
- Tenant-Isolation in allen athleten- und testbezogenen Abfragen,
- keine Ausgabe von Namen, Geburtsdatum oder anderen direkten Identifikatoren,
- keine Datei-Löschung oder Veränderung von `storage_reference`,
- keine Audit-Redaktion; dafür bleibt ausschließlich der kontrollierte Privacy-Maintenance-Pfad zuständig,
- keine automatische Verarbeitung aktiver Exportpakete,
- keine implizite Annahme, dass nicht deklarierte Backup-/Notification-Funktionen deaktiviert sind,
- `passesIrreversiblePrecheck = true` ist weiterhin nur eine notwendige Vorbedingung.

## Nachgelagerte Ausführung

Preview, Policy und Capability-Attestation werden inzwischen durch einen fingerprintgebundenen Admin-Approval-Vertrag sowie den durablen Execution-/Artifact-Manifest-Vertrag ergänzt. Der spätere Writer muss den Zustand unmittelbar vor dem ersten Artifact-Stage erneut validieren und darf nur gegen exakt die manifestierten Referenzen arbeiten.

Die Preview selbst bleibt trotzdem vollständig read-only und kann weder Approval noch Execution noch irreversible Verarbeitung auslösen.
