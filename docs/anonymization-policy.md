# Anonymisierungs-Policy

## Status

Aktuelle Policy-Version: `1.5.0`.

Die Policy ist ausschließlich ein **fail-closed Entscheidungsvertrag** für die read-only Anonymisierungs-Preview. Sie erteilt keine Ausführungsfreigabe: `executionAllowed` bleibt typseitig `false`.

## Profil und historische Snapshots

### Aktuelles Athletenprofil

Disposition: `MINIMIZE_ATHLETE_TOMBSTONE`.

Policy v1.5 verschärft die frühere reine Direkt-Identifier-Redaktion. Nach der irreversiblen Verarbeitung bleibt nur der technische Athletenanker samt bereits vorhandenen Compliance-/Lifecycle-Bezügen erhalten. Sämtliche rückführbaren oder quasi-identifizierenden Profilwerte werden auf einen deterministischen Tombstone gesetzt:

- `linkedUserId = null`,
- Name/Klassifikationsfelder = `[ANONYMIZED]`,
- Geburtsdatum = `0001-01-01`,
- Körpergröße und Gewicht = `0`.

Die Null-/Sentinelwerte sind ausdrücklich keine plausiblen Ersatzdaten. Der normale Athleten-Create-/Update-Pfad bleibt unverändert streng; gelöschte Athleten sind dort ohnehin ausgeschlossen. Eine alte Approval unter Policy v1.4 darf nicht weiterverwendet werden und wird durch die Versionsbindung automatisch ungültig.

### Athleten-Snapshots

Disposition: `REMOVE_ATHLETE_SNAPSHOTS`.

Historische Athleten-Snapshots können frühere Namen, Geburtsdaten und weitere Identitätsanker enthalten. Nach abgelaufener Aufbewahrung werden sie nicht in eine neue pseudonyme Repräsentation überführt, sondern entfernt.

### Testplan-Snapshots

Disposition: `REMOVE_TEST_PLAN_SNAPSHOTS`.

Testplan-Snapshots verbinden historische Athleten-/Planungsdaten mit individuellen Testverläufen. Da die Policy auch die detaillierten Diagnostikdaten entfernt, besteht kein fachlicher Zweck für eine separate anonymisierte Weiterhaltung dieser Snapshots.

## Beziehungs- und Privacy-Daten

### Coach-Zuordnungen

Disposition: `REMOVE_COACH_RELATIONSHIPS`.

Nach abgeschlossener irreversibler Verarbeitung besteht kein fachlicher Zweck mehr für die Zuordnung eines Trainers zum betroffenen Athleten. Historische Nachvollziehbarkeit bleibt ausschließlich über den minimierten Audit-Trail erhalten.

### Einwilligungsnachweise

Disposition: `PRESERVE_MINIMIZED_CONSENT_RECORDS`.

Status, Einwilligungstyp, Dokumentversion und Lifecycle-Zeitpunkte können nach Entfernung aller rückführbaren Identitätsanker als minimierter Compliance-Nachweis erhalten bleiben. Die Policy erlaubt keine erneute Anreicherung um Identifikatoren.

### Guardian-Datensätze

Disposition: `REMOVE_GUARDIAN_RECORDS`.

Guardian-Name, E-Mail und Telefonnummer sind personenbezogene Daten einer dritten Person. Nach Wegfall des fachlichen Zwecks werden die Guardian-Datensätze vollständig entfernt.

### Löschworkflow

Disposition: `REDACT_DELETION_REQUEST_FREE_TEXT`.

Status und Workflow-Zeitpunkte bleiben als Compliance-Nachweis erhalten. `reason` und `decisionReason` können direkte oder indirekte Identifikatoren enthalten und müssen redigiert werden.

## Diagnostik- und Betriebsdaten

Disposition: `REMOVE_DIAGNOSTIC_AND_OPERATIONAL_RECORDS`.

Nach Ablauf der zulässigen Aufbewahrungsfrist werden die individuellen Diagnostik- und Verlaufsdaten gelöscht statt unter einem nur pseudonymen technischen Bezug weitergeführt. Exakte Leistungs-, Herzfrequenz- und Laktatverläufe, Zeitpunkte, Geräte-/Protokollmerkmale und wiederholte Testhistorien können auch ohne direkte Identifikatoren reidentifizierbar sein.

Der anonymisierte Analyseexport bleibt davon getrennt: Er ist ein bewusst generalisierter Exportvertrag und rechtfertigt nicht die dauerhafte Weiterhaltung detaillierter Primärdaten.

Die Mindestaufbewahrung des Audit-Trails wird separat erfüllt. Audit-Datensätze werden über die implementierte PII-Minimierung und den kontrollierten historischen Privacy-Maintenance-Pfad geschützt.

## Report- und Exportartefakte

### Report-Versionen und PDF-Artefakte

Disposition: `REMOVE_REPORT_ARTIFACTS_AND_RECORDS`.

Persistierte Reports enthalten Namen und detaillierte individuelle Diagnostikergebnisse. Vor der fachlichen DB-Löschung wird das PDF zunächst in die ausführungsgebundene Quarantäne verschoben. Die ursprüngliche `report_versions`-Historie bleibt im Normalbetrieb weiterhin immutable.

Migration `0016_report_privacy_delete.sql` erweitert deshalb **nur** den bestehenden DELETE-Trigger: Eine Reportversion darf ausschließlich gelöscht werden, wenn

- eine passende `REPORT`-Referenz im unveränderlichen Execution-Manifest existiert,
- diese Manifest-Referenz exakt der `storage_reference` der Reportversion entspricht,
- die Execution zum Athleten des Tests gehört,
- und die Execution aktuell `ARTIFACTS_STAGED` ist.

UPDATE bleibt ausnahmslos verboten. Es gibt kein globales Abschalten der Immutable-Invariante.

### Aktive Tenant-Exportpakete

Disposition: `REMOVE_ACTIVE_TENANT_EXPORT_PACKAGES`.

Ein vollständiges Tenant-Exportpaket kann eine noch identifierhaltige Kopie des Athletenbestands enthalten. Vor irreversibler Verarbeitung werden aktive Pakete anhand des durablen Execution-Manifests in Quarantäne verschoben und die DB-Zeilen erst im fachlichen Commit entfernt.

## Globale Privacy-Capabilities

Die Backup-/Notification-Review-Punkte werden durch zwei explizite versionierte Laufzeitverträge aufgelöst:

- `BACKUP_PRIVACY_POLICY_V1`,
- `NOTIFICATION_PRIVACY_POLICY_V1`.

Ohne explizite Capability-Deklaration bleibt `GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED` aktiv. Bei erfolgreicher Attestation entfällt nur dieser Blocker; die separate administrative Freigabe bleibt zwingend bestehen.

Die Details stehen in `docs/global-privacy-policy.md`.

## Verbleibende Ausführungs-Gates

Mit Policy v1.5 und dem Execution-/Quarantäne-Vertrag sind die derzeit bekannten Datenschutz- und Dateisystemregeln versioniert definiert. Vor dem eigentlichen irreversiblen Commit bleiben weiterhin zwingend:

- erfolgreiche Laufzeit-Attestation,
- neue explizite Approval unter Policy v1.5,
- erneute Fresh-Validation unmittelbar vor dem ersten Stage,
- Manifestgleichheit mit der aktuellen Preview,
- transaktionale fachliche DB-Mutation inklusive Audit-Privacy-Pfad und `ARTIFACTS_STAGED -> DB_COMMITTED`,
- finaler Quarantäne-Purge mit retrybarer Recovery und Abschluss-Audit.

## Fail-closed-Regeln

- unbekannte zukünftige Preview-Scopes werden automatisch `POLICY_REVIEW_REQUIRED`,
- unbekannte zukünftige globale Anforderungen bleiben `UNRESOLVED_GLOBAL_POLICY_REQUIREMENT`,
- fehlende Runtime-Capability-Deklarationen sind blockierend und nicht gleichbedeutend mit `DISABLED`,
- administrative Freigabe bleibt separat erforderlich,
- die Policy selbst mutiert keine Daten und löscht keine Dateien,
- Audit-Altbestand darf ausschließlich über den kontrollierten Privacy-Maintenance-Pfad behandelt werden,
- vorhandene Audit-Redaktionsnachweise müssen erhalten bleiben,
- externe Artefakte müssen vor dem Entfernen ihrer referenzierenden Datenbankzeilen staged sein,
- normale Reporthistorie bleibt immutable; Privacy-DELETE ist nur execution- und manifestgebunden zulässig.
