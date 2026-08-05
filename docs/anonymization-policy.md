# Anonymisierungs-Policy

## Status

Aktuelle Policy-Version: `1.4.0`.

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

Der anonymisierte Analyseexport bleibt davon getrennt: Er ist ein bewusst generalisierter Exportvertrag mit pseudonymen IDs, Zeitperioden und Klassenbildung sowie Seltenheits-/Reidentifikationsprüfung und rechtfertigt nicht die dauerhafte Weiterhaltung detaillierter Primärdaten.

Die Mindestaufbewahrung des Audit-Trails wird separat erfüllt. Audit-Datensätze werden über die implementierte PII-Minimierung und den kontrollierten historischen Privacy-Maintenance-Pfad geschützt.

## Report- und Exportartefakte

### Report-Versionen und PDF-Artefakte

Disposition: `REMOVE_REPORT_ARTIFACTS_AND_RECORDS`.

Persistierte Reports enthalten Namen und detaillierte individuelle Diagnostikergebnisse. Bei der späteren atomaren Ausführung muss zuerst das externe PDF-Artefakt über seine `storage_reference` entfernt und anschließend der zugehörige `report_versions`-Datensatz gelöscht werden. Der vorhandene Report-Storage stellt dafür bereits eine idempotente `remove()`-Operation bereit.

### Aktive Tenant-Exportpakete

Disposition: `REMOVE_ACTIVE_TENANT_EXPORT_PACKAGES`.

Ein vollständiges Tenant-Exportpaket kann eine noch identifierhaltige Kopie des Athletenbestands enthalten. Vor irreversibler Verarbeitung müssen deshalb alle noch aktiven Exportpakete des Tenants entfernt werden. Der bestehende Export-Lifecycle besitzt bereits die benötigte Reihenfolge: Storage-Datei löschen, danach den Paketdatensatz entfernen.

## Globale Privacy-Capabilities

Policy v1.4 löst die bisherigen Backup-/Notification-Review-Punkte nicht durch Annahmen, sondern durch zwei explizite versionierte Laufzeitverträge auf:

- `BACKUP_PRIVACY_POLICY_V1`,
- `NOTIFICATION_PRIVACY_POLICY_V1`.

Die semantische Policy ist damit für alle aktuell bekannten globalen Anforderungen definiert. Ob sie im konkreten Betrieb tatsächlich erfüllt sind, muss separat über `evaluateGlobalPrivacyCapabilities()` attestiert werden.

### Backup

Ein Backup-System darf nur als erfüllt gelten, wenn es explizit `DISABLED` ist oder bei `ENABLED` mindestens Verschlüsselung im Ruhezustand, begrenzte Aufbewahrung und Privacy-Reconciliation bei Restore unter Policy-Version `1.0.0` nachweist. Fehlende Angaben bleiben blockierend.

### Notifications

Notifications dürfen nur als erfüllt gelten, wenn sie explizit `DISABLED` sind oder bei `ENABLED` einen athletenbezogenen Subject-Scope, Verbot direkter Identifikatoren und gezielten Subject-Cleanup unter Policy-Version `1.0.0` technisch unterstützen.

Die derzeit vorhandene generische `notifications.payload_json`-Tabelle allein reicht dafür ausdrücklich nicht aus. Eine spätere Notification-Implementierung darf die Capability erst nach technischer Durchsetzung dieses Vertrags als `ENABLED` deklarieren.

### Fail-closed Attestation

Ohne explizite Capability-Deklaration bleibt `GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED` aktiv. Bei erfolgreicher Attestation entfällt nur dieser Blocker; die separate administrative Freigabe bleibt zwingend bestehen.

Die Details stehen in `docs/global-privacy-policy.md`.

## Verbleibende Ausführungs-Gates

Mit Policy v1.4 sind alle derzeit bekannten row-level und globalen Datenschutzregeln versioniert definiert. Vor einem irreversiblen Writer bleiben jedoch weiterhin zwingend:

- erfolgreiche Laufzeit-Attestation der benötigten globalen Privacy-Capabilities,
- explizite administrative Ausführungsfreigabe,
- atomare Ausführung mit überprüfbarer Fehlerstrategie und eigenem Audit-Ereignis.

## Fail-closed-Regeln

- unbekannte zukünftige Preview-Scopes werden automatisch `POLICY_REVIEW_REQUIRED`,
- unbekannte zukünftige globale Anforderungen bleiben `UNRESOLVED_GLOBAL_POLICY_REQUIREMENT`,
- fehlende Runtime-Capability-Deklarationen sind blockierend und nicht gleichbedeutend mit `DISABLED`,
- administrative Freigabe bleibt auch für vollständig definierte und attestierte Scopes separat erforderlich,
- die Policy selbst mutiert keine Daten und löscht keine Dateien,
- Audit-Altbestand darf ausschließlich über den kontrollierten Privacy-Maintenance-Pfad behandelt werden,
- vorhandene Audit-Redaktionsnachweise müssen erhalten bleiben,
- externe Artefakte müssen vor dem Entfernen ihrer referenzierenden Datenbankzeilen behandelt werden.
