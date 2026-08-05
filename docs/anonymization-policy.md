# Anonymisierungs-Policy

## Status

Aktuelle Policy-Version: `1.2.0`.

Die Policy ist ausschließlich ein **fail-closed Entscheidungsvertrag** für die read-only Anonymisierungs-Preview. Sie erteilt keine Ausführungsfreigabe: `executionAllowed` bleibt typseitig `false`.

## Profil und historische Snapshots

### Aktuelles Athletenprofil

Disposition: `REDACT_DIRECT_IDENTIFIERS`.

Direkte Identifikatoren und rückführbare Login-Verknüpfungen müssen entfernt bzw. redigiert werden. Ein minimaler technischer Athletenanker darf ausschließlich für verbleibende Compliance-/Audit-Nachweise bestehen bleiben, sofern nach der Ausführung keine Rückführung auf die natürliche Person mehr möglich ist.

### Athleten-Snapshots

Disposition: `REMOVE_ATHLETE_SNAPSHOTS`.

Historische Athleten-Snapshots können frühere Namen, Geburtsdaten und weitere Identitätsanker enthalten. Nach abgelaufener Aufbewahrung werden sie nicht in eine neue pseudonyme Repräsentation überführt, sondern später entfernt.

### Testplan-Snapshots

Disposition: `REMOVE_TEST_PLAN_SNAPSHOTS`.

Testplan-Snapshots verbinden historische Athleten-/Planungsdaten mit individuellen Testverläufen. Da Policy v1.2 auch die detaillierten Diagnostikdaten entfernt, besteht kein fachlicher Zweck für eine separate anonymisierte Weiterhaltung dieser Snapshots.

## Beziehungs- und Privacy-Daten

Die frühere Sammelklasse `RELATIONSHIP_AND_PRIVACY_RECORDS` wurde aufgelöst, weil die enthaltenen Datensätze unterschiedliche Zwecke und Risiken haben.

### Coach-Zuordnungen

Disposition: `REMOVE_COACH_RELATIONSHIPS`.

Nach abgeschlossener Löschung bzw. irreversibler Verarbeitung besteht kein fachlicher Zweck mehr für die Zuordnung eines Trainers zum betroffenen Athleten. Die spätere Ausführung darf diese Zuordnungszeilen deshalb entfernen. Historische Nachvollziehbarkeit bleibt ausschließlich über den minimierten Audit-Trail erhalten.

### Einwilligungsnachweise

Disposition: `PRESERVE_MINIMIZED_CONSENT_RECORDS`.

Die aktuelle Tabelle enthält Status, Einwilligungstyp, Dokumentversion und Lifecycle-Zeitpunkte sowie den technischen Athletenbezug, aber keine Namen oder Kontaktdaten. Nach Entfernung aller rückführbaren Identitätsanker kann dieser minimierte Compliance-Nachweis erhalten bleiben. Die Policy erlaubt keine erneute Anreicherung um Identifikatoren.

### Guardian-Datensätze

Disposition: `REMOVE_GUARDIAN_RECORDS`.

Guardian-Name, E-Mail und Telefonnummer sind personenbezogene Daten einer dritten Person. Nach Wegfall des fachlichen Zwecks werden die Guardian-Datensätze später vollständig entfernt. Beziehung und Lifecycle bleiben, soweit erforderlich, im bereits PII-minimierten Audit-Trail nachvollziehbar.

### Löschworkflow

Disposition: `REDACT_DELETION_REQUEST_FREE_TEXT`.

Status und Workflow-Zeitpunkte bleiben als Compliance-Nachweis erhalten. `reason` und `decisionReason` sind Freitextfelder und können direkte oder indirekte Identifikatoren enthalten; sie müssen bei der späteren irreversiblen Verarbeitung redigiert werden.

## Diagnostik- und Betriebsdaten

Disposition: `REMOVE_DIAGNOSTIC_AND_OPERATIONAL_RECORDS`.

Policy v1.2 entscheidet sich nach Ablauf der zulässigen Aufbewahrungsfrist bewusst für **Löschung** der individuellen Diagnostik- und Verlaufsdaten statt für eine nur behauptete Anonymisierung. Dazu gehören die athletenbezogenen Tests und die zugehörigen Mess-, Qualitäts-, Korrektur-, Schwellen-, Ergebnis-, Interpretations-, Zonen-, Lock- und Sync-Datensätze.

Begründung:

- exakte Leistungs-, Herzfrequenz- und Laktatverläufe können für eine Person charakteristisch sein,
- Zeitpunkte, Protokolle, Geräteart und wiederholte Testhistorien bilden zusätzliche Quasi-Identifikatoren,
- das Entfernen von Name und Geburtsdatum beseitigt dieses Reidentifikationsrisiko nicht zuverlässig,
- SPEC §32.3 erlaubt nach Prüfung der Aufbewahrungsgründe ausdrücklich Löschung **oder** irreversible Anonymisierung; die konservativere Löschung vermeidet eine unbelegte Anonymitätsannahme.

Der bereits vorhandene anonymisierte Analyseexport bleibt davon getrennt: Er ist ein bewusst generalisierter Exportvertrag mit pseudonymen IDs, Zeitperioden und Klassenbildung sowie Seltenheits-/Reidentifikationsprüfung. Er rechtfertigt nicht die dauerhafte Weiterhaltung der detaillierten Primärdaten eines gelöschten Athleten.

Die Mindestaufbewahrung des Audit-Trails wird separat erfüllt. Audit-Datensätze werden nicht zusammen mit den detaillierten Diagnostikdaten gelöscht, sondern über die bereits implementierte PII-Minimierung und den kontrollierten historischen Privacy-Maintenance-Pfad geschützt.

## Weiterhin offene Policy-Gates

Policy v1.2.0 lässt nur noch folgende fachlich/operativ offenen Bereiche zu:

- `REPORT_DATABASE_RECORDS`: Datenbankzeile und externes Report-Artefakt müssen gemeinsam behandelt werden.
- `ACTIVE_TENANT_EXPORT_PACKAGES`: aktive vollständige Exporte können identifierhaltige Kopien enthalten.
- globale Backup- und Notification-Speicherorte, die derzeit nicht verlässlich row-level einem Athleten zugeordnet werden können.
- die separate explizite administrative Ausführungsfreigabe.

Solange mindestens eines dieser Gates offen ist, bleibt ein irreversibler Writer gesperrt.

## Fail-closed-Regeln

- unbekannte zukünftige Preview-Scopes werden automatisch `POLICY_REVIEW_REQUIRED`,
- administrative Freigabe bleibt auch für vollständig definierte Scopes separat erforderlich,
- die Policy selbst mutiert keine Daten und löscht keine Dateien,
- Audit-Altbestand darf ausschließlich über den kontrollierten Privacy-Maintenance-Pfad behandelt werden,
- vorhandene Audit-Redaktionsnachweise müssen erhalten bleiben.
