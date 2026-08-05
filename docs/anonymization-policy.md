# Anonymisierungs-Policy

## Status

Aktuelle Policy-Version: `1.3.0`.

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

Persistierte Reports enthalten Namen und detaillierte individuelle Diagnostikergebnisse. Policy v1.3 verlangt deshalb, dass bei der späteren atomaren Ausführung **zuerst das externe PDF-Artefakt über seine `storage_reference` entfernt und anschließend der zugehörige `report_versions`-Datensatz gelöscht wird**. Der vorhandene Report-Storage stellt dafür bereits eine idempotente `remove()`-Operation bereit.

Die Preview liefert sämtliche betroffenen `storage_reference`-Werte vorab. Ein fehlgeschlagener Artifact-Delete darf in einem späteren Writer nicht still ignoriert werden; die Datenbanklöschung darf erst nach bestätigter Storage-Behandlung fortgesetzt werden.

### Aktive Tenant-Exportpakete

Disposition: `REMOVE_ACTIVE_TENANT_EXPORT_PACKAGES`.

Ein vollständiges Tenant-Exportpaket kann eine noch identifierhaltige Kopie des Athletenbestands enthalten. Vor irreversibler Verarbeitung müssen deshalb alle noch aktiven Exportpakete des Tenants entfernt werden. Der bestehende Export-Lifecycle besitzt bereits die benötigte Reihenfolge: Storage-Datei löschen, danach den Paketdatensatz entfernen.

Die Policy behandelt dies konservativ tenantweit, weil ein vollständiges Exportpaket nicht zuverlässig auf einen einzelnen Athleten reduziert werden kann. Abgelaufene Pakete unterliegen ohnehin dem vorhandenen Cleanup-Pfad.

`REPORT_STORAGE_VERIFICATION` bleibt als Preview-Hinweis sichtbar, ist in Policy v1.3 aber kein offenes Review-Gate mehr: Die explizite Löschdisposition definiert die erforderliche Storage-Behandlung.

## Weiterhin offene globale Policy-Gates

Alle aktuell bekannten row-level Scopes sind mit Policy v1.3 versioniert aufgelöst. Offen bleiben ausschließlich:

- `BACKUP_RETENTION_POLICY_REVIEW`,
- `NOTIFICATION_PAYLOAD_REVIEW`,
- die separate explizite administrative Ausführungsfreigabe.

Backups und Notification-Payloads werden bewusst nicht durch Annahmen über ihre spätere Implementierung freigegeben. Solange diese globalen Gates offen sind, bleibt ein irreversibler Writer gesperrt.

## Fail-closed-Regeln

- unbekannte zukünftige Preview-Scopes werden automatisch `POLICY_REVIEW_REQUIRED`,
- administrative Freigabe bleibt auch für vollständig definierte Scopes separat erforderlich,
- die Policy selbst mutiert keine Daten und löscht keine Dateien,
- Audit-Altbestand darf ausschließlich über den kontrollierten Privacy-Maintenance-Pfad behandelt werden,
- vorhandene Audit-Redaktionsnachweise müssen erhalten bleiben,
- externe Artefakte müssen vor dem Entfernen ihrer referenzierenden Datenbankzeilen behandelt werden.
