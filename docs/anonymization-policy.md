# Anonymisierungs-Policy

## Status

Aktuelle Policy-Version: `1.1.0`.

Die Policy ist ausschließlich ein **fail-closed Entscheidungsvertrag** für die read-only Anonymisierungs-Preview. Sie erteilt keine Ausführungsfreigabe: `executionAllowed` bleibt typseitig `false`.

## Beziehungs- und Privacy-Daten

Die frühere Sammelklasse `RELATIONSHIP_AND_PRIVACY_RECORDS` wurde aufgelöst, weil die enthaltenen Datensätze unterschiedliche Zwecke und Risiken haben.

### Coach-Zuordnungen

Disposition: `REMOVE_COACH_RELATIONSHIPS`.

Nach abgeschlossener Löschung bzw. irreversibler Anonymisierung besteht kein fachlicher Zweck mehr für die Zuordnung eines Trainers zum anonymisierten Athleten. Die spätere Ausführung darf diese Zuordnungszeilen deshalb entfernen. Historische Nachvollziehbarkeit bleibt ausschließlich über den minimierten Audit-Trail erhalten.

### Einwilligungsnachweise

Disposition: `PRESERVE_MINIMIZED_CONSENT_RECORDS`.

Die aktuelle Tabelle enthält Status, Einwilligungstyp, Dokumentversion und Lifecycle-Zeitpunkte sowie den technischen Athletenbezug, aber keine Namen oder Kontaktdaten. Nach Entfernung aller rückführbaren Identitätsanker kann dieser minimierte Compliance-Nachweis erhalten bleiben. Die Policy erlaubt keine erneute Anreicherung um Identifikatoren.

### Guardian-Datensätze

Disposition: `REMOVE_GUARDIAN_RECORDS`.

Guardian-Name, E-Mail und Telefonnummer sind personenbezogene Daten einer dritten Person. Nach Wegfall des fachlichen Zwecks werden die Guardian-Datensätze später vollständig entfernt. Beziehung und Lifecycle bleiben, soweit erforderlich, im bereits PII-minimierten Audit-Trail nachvollziehbar.

### Löschworkflow

Disposition: `REDACT_DELETION_REQUEST_FREE_TEXT`.

Status und Workflow-Zeitpunkte bleiben als Compliance-Nachweis erhalten. `reason` und `decisionReason` sind Freitextfelder und können direkte oder indirekte Identifikatoren enthalten; sie müssen bei der späteren irreversiblen Verarbeitung redigiert werden.

## Weiterhin offene Policy-Gates

Policy v1.1.0 trifft bewusst noch keine abschließende Entscheidung für:

- `DIAGNOSTIC_AND_OPERATIONAL_RECORDS`: detaillierte Mess- und Verlaufsdaten können trotz Entfernung direkter Identifikatoren reidentifizierbar sein.
- `REPORT_DATABASE_RECORDS`: Datenbankzeile und externes Report-Artefakt müssen gemeinsam behandelt werden.
- `ACTIVE_TENANT_EXPORT_PACKAGES`: aktive vollständige Exporte können identifierhaltige Kopien enthalten.
- globale Backup- und Notification-Speicherorte, die derzeit nicht verlässlich row-level einem Athleten zugeordnet werden können.

Solange mindestens eines dieser Gates offen ist, bleibt ein irreversibler Writer gesperrt.

## Fail-closed-Regeln

- unbekannte zukünftige Preview-Scopes werden automatisch `POLICY_REVIEW_REQUIRED`,
- administrative Freigabe bleibt auch für vollständig definierte Scopes separat erforderlich,
- die Policy selbst mutiert keine Daten und löscht keine Dateien,
- Audit-Altbestand darf ausschließlich über den kontrollierten Privacy-Maintenance-Pfad behandelt werden,
- vorhandene Audit-Redaktionsnachweise müssen erhalten bleiben.
