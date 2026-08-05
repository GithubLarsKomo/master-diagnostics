# Read-only Anonymisierungs-Preview

## Zweck

`getAthleteAnonymizationPreview()` erzeugt vor jeder späteren irreversiblen Verarbeitung eine tenantgebundene, deterministische und vollständig read-only Übersicht der Datenklassen, die für einen Athleten behandelt werden müssen.

Die Preview ist **keine Ausführungsfreigabe**. Sie kombiniert den bestehenden irreversiblen Precheck mit einem Scope-Inventar. Die Preview selbst bleibt neutral und kennzeichnet detaillierte Diagnostikdaten weiterhin als Reidentifikationsrisiko; die versionierte Policy legt fest, wie dieses Risiko behandelt wird.

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

Zusätzlich werden globale Anforderungen ausgewiesen, die nicht zuverlässig row-level einem einzelnen Athleten zugeordnet werden können: Report-Storage-Verifikation, Backup-Retention und Notification-Payload-Prüfung.

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

Die Aufteilung der früher zusammengefassten Beziehungs-/Privacy-Daten verhindert, dass unterschiedliche Datenschutzanforderungen in einer einzigen Sammelentscheidung verborgen werden. Coach-Zuordnungen, Einwilligungsnachweise, Guardian-Daten und Löschworkflow werden deshalb als eigene Scopes ausgewiesen.

`REIDENTIFICATION_RISK_REVIEW_REQUIRED` bedeutet weiterhin, dass diagnostische Daten nicht allein durch Entfernung von Name und Geburtsdatum automatisch als anonym gelten. Policy v1.2.0 löst dieses Review-Gate konservativ auf: detaillierte individuelle Diagnostik-/Verlaufsdaten sowie Athlete-/Testplan-Snapshots werden nach erfüllter Retention und späterer expliziter Freigabe entfernt statt unter einer nur pseudonymen technischen Verknüpfung weitergeführt.

## Sicherheitsgrenzen

- ausschließlich `SELECT`-Zugriffe in der Scope-Ermittlung,
- Tenant-Isolation in allen athleten- und testbezogenen Abfragen,
- keine Ausgabe von Namen, Geburtsdatum oder anderen direkten Identifikatoren,
- keine Datei-Löschung oder Veränderung von `storage_reference`,
- keine Audit-Redaktion; dafür bleibt ausschließlich der kontrollierte Privacy-Maintenance-Pfad zuständig,
- keine automatische Verarbeitung aktiver Exportpakete,
- `passesIrreversiblePrecheck = true` ist weiterhin nur eine notwendige Vorbedingung.

## Nächste Gates

Policy v1.2.0 schließt sowohl die Beziehungs-/Privacy-Entscheidungen als auch das Reidentifikations-Gate für detaillierte Diagnostikdaten. Offen bleiben Report-/Datei-/Exportartefakte sowie globale Backup-/Notification-Anforderungen. Erst nach deren versionierter Auflösung kann eine explizite administrative Ausführungsfreigabe und schließlich ein atomarer irreversibler Writer implementiert werden.
