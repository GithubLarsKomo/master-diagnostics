# Betroffenenexport

## Ziel

Der Betroffenenexport ist ein eigener DSGVO-/Datenschutzpfad und **kein** vollständiger Tenant-Portabilitätsexport. Er sammelt ausschließlich die fachlichen Daten eines einzelnen Athleten innerhalb genau eines Tenants.

Der Datenquellenpfad ist bewusst read-only. Er erzeugt noch kein automatisch zustellbares Paket und schreibt deshalb auch noch keinen Export-Audit. Die spätere administrative Erzeugung/Auslieferung muss gemäß `SPEC.md` §33.1 als Exportereignis auditiert werden.

## Versionierter Source-Vertrag

Schema-Version: `masters-data-subject-export-v1`.

Der Domain-Vertrag enthält:

- `tenantId`
- `athleteId`
- `exportedAt`
- feste, versionierte Datenabschnitte
- Referenzen auf zugehörige Report-PDFs

Die JSON-Darstellung ist deterministisch strukturiert und enthält auch leere Abschnitte, damit Consumer nicht anhand fehlender Keys zwischen „keine Daten“ und „nicht exportiert“ unterscheiden müssen.

## Eingeschlossene fachliche Daten

Der read-only Source umfasst:

- Athletenprofil und historische Athleten-Snapshots
- Trainer-Athleten-Zuordnungen
- Einwilligungen
- Guardian-Datensätze
- Lösch-/Anonymisierungsworkflow
- Tests
- Testplan-Snapshots
- Sicherheitsbestätigungen und Abbruchereignisse
- Stufen-, Ruhe- und Erholungsmessungen
- Qualitätskennzeichen und Messwertkorrekturen
- automatische Schwellenläufe und Ergebnisse
- diagnostische Ergebnis-Snapshots
- Interpretationen und Trainingszonen
- Berichtsversionen

Alle indirekten Test-/Interpretationsbeziehungen werden sowohl über `tenant_id` als auch über die gebundene Athleten-/Testbeziehung eingeschränkt.

## Bewusst nicht eingeschlossen

Der Source enthält nicht:

- fremde Athleten oder Daten anderer Tenants
- tenantweite Nutzerlisten und Rollen
- Tenant-Konfiguration und Branding
- Passwort-Hashes, Sessions, Tokens, Secrets oder Schlüssel
- tenantweite Exportpakete
- interne Audit-Logs oder Audit-Privacy-Nachweise
- Dateiinhalte der Report-PDFs

Audit-Logs werden nicht pauschal in eine automatisch zustellbare Datenkopie aufgenommen, weil sie Identitäten und Rechte Dritter enthalten können. Ihre Behandlung benötigt einen expliziten Auslieferungsvertrag statt eines ungefilterten Tenant-Audit-Dumps.

## Report-Artefakte

`report_versions` werden als fachliche Datensätze exportiert. Zusätzlich liefert der Source für jede Berichtsversion eine externe Referenz mit:

- Report-Version-ID
- `storageReference`
- Medientyp `application/pdf`

Der read-only DB-Service liest keine Dateien. Die spätere Paketierung muss die tatsächlich vorhandenen PDFs über den Report-Storage laden, Integrität prüfen und kontrolliert in das Zustellpaket aufnehmen.

## Delivery-Privacy-Projection

Der interne Source ist nicht automatisch zustellbar. Die versionierte Policy `masters-data-subject-delivery-v1` erzeugt deshalb mit `projectAthleteDataSubjectExportForDelivery()` eine getrennte, fail-closed Auslieferungsprojektion.

### Automatische strukturierte Redaktionen

Bekannte Drittpersonen-Identifikatoren werden deterministisch durch `[THIRD_PARTY_REDACTED]` ersetzt. Dazu gehören insbesondere:

- `full_name`, `email` und `phone` in Guardian-Datensätzen,
- `coach_user_id`,
- technische Mitarbeiter-/Trainerreferenzen mit Suffix `_by_user_id` oder `_trainer_user_id`.

Die eigene `linked_user_id` des Athleten bleibt erhalten, weil sie zum betroffenen Datensatz selbst gehört.

Jede automatische Redaktion erzeugt ausschließlich PII-freie Metadaten aus Section, Row-ID, Feld und Redaktionsgrund. Der entfernte Wert wird nicht in die Redaktionsliste kopiert.

### Freitext: Review statt heuristischer Redaktion

Nichtleere Freitextfelder wie `notes`, `reason`, `decision_reason` oder `rationale` können Namen oder andere Drittpersonenangaben enthalten. Sie werden deshalb nicht per Heuristik, Regex oder LLM automatisch verändert.

Stattdessen gilt:

- der komplette Feldinhalt wird in der Auslieferungsprojektion durch `[REVIEW_REQUIRED]` ersetzt,
- ein Review-Punkt enthält nur Section, Row-ID, Feld und Grund,
- der ursprüngliche Freitext erscheint weder in der Auslieferungsprojektion noch im Review-Metadatensatz,
- `readyForDelivery` ist `false`, solange mindestens ein solcher Review-Punkt offen ist.

Damit kann kein unreviewter Freitext versehentlich in ein späteres Betroffenenpaket gelangen.

## Administrative Review-/Freigabe

Migration `0019_data_subject_delivery_approvals` und `approveAthleteDataSubjectDeliveryReview()` führen einen separaten, unveränderlichen Freigabevertrag ein. Die Freigabe ist noch **keine** Auslieferung; sie autorisiert ausschließlich, welche der aktuell inventarisierten Freitextfelder in einem späteren reviewed Delivery-Snapshot übernommen oder redigiert werden dürfen.

Zulässige Entscheidungen je Review-Punkt:

- `INCLUDE_ORIGINAL`
- `REDACT`

Für jede aktuelle Review-Position muss exakt eine Entscheidung vorhanden sein. Fehlende, doppelte oder zusätzliche Entscheidungen werden fail-closed abgewiesen.

### PII-armer Approval-Datensatz

`athlete_data_subject_delivery_approvals` speichert ausschließlich:

- Tenant- und technische Athlete-ID,
- Approval-Version,
- Source-Schema-Version und Delivery-Policy-Version,
- Prüfzeitpunkt,
- SHA-256-Source-Fingerprint,
- SHA-256-Decision-Fingerprint,
- Section, Row-ID, Feld und Entscheidung je Review-Punkt,
- freigebenden Tenant-Admin und Zeitstempel.

Der geprüfte Freitext selbst wird **nicht** in der Approval und nicht im Approval-Audit gespeichert. `INCLUDE_ORIGINAL` bedeutet daher nur, dass ein späterer Paketierungsschritt den dann noch aktuellen Rohwert nach erneuter Validierung übernehmen darf.

### Fingerprint-Bindung und Drift

Der Source-Fingerprint bindet:

- die vollständigen aktuellen fachlichen Source-Daten,
- Report-Artefaktreferenzen,
- Source-Schema- und Delivery-Policy-Version,
- automatische Drittpersonen-Redaktionen,
- das vollständige aktuelle Review-Item-Set.

Der Decision-Fingerprint bindet die normalisierte Entscheidungsliste. Jede Änderung des fachlichen Source, des Review-Scopes oder der Vertragsversion macht eine bestehende Freigabe für die spätere Paketierung ungültig.

`validateAthleteDataSubjectDeliveryApproval()` revalidiert diese Bindung gegen den aktuellen Source. Eine Approval darf nur weiterverwendet werden, wenn `validForDeliveryPackaging=true` und keine Blocker vorliegen.

### Immutability und Idempotenz

- Approval-UPDATE und -DELETE werden DB-seitig per Trigger blockiert.
- Derselbe Tenant-Admin erhält bei identischem Source-/Decision-Scope idempotent dieselbe Approval zurück; es entsteht kein zweites Audit-Ereignis.
- Ein zweiter Tenant-Admin kann denselben Scope unabhängig freigeben.
- Das Audit `athlete.data_subject_delivery_review_approved` enthält nur Versionen, Fingerprints und technische Zähler, keinen Roh-Freitext oder Guardian-Kontaktdaten.

## Noch keine Auslieferung

Source, Delivery-Projection und Review-Approval zusammen:

- erzeugen noch kein Downloadpaket,
- lesen noch keine Report-PDF-Dateiinhalte,
- schreiben noch keinen finalen Export-/Download-Audit,
- veröffentlichen keine Web- oder Download-Route.

Der nächste Schritt ist eine deterministische reviewed Delivery-Projection, die eine frisch validierte Approval auf den aktuellen Source anwendet. Erst danach folgen PDF-Integrität/Paketierung und die tatsächliche auditierte Auslieferung.

## Sicherheitsinvarianten

`getAthleteDataSubjectExportSource()`:

- ist vollständig read-only,
- liefert `null`, wenn der Athlet nicht zum angefragten Tenant gehört,
- fragt jede Tabelle tenantgebunden ab,
- übernimmt keine tenantweiten Tabellen aus dem Portabilitätsexport,
- mutiert weder Fachdaten noch Audit-Log,
- liefert externe Report-Artefakte nur als technische Referenzen.

`projectAthleteDataSubjectExportForDelivery()`:

- verändert den Source nicht,
- entfernt bekannte strukturierte Drittpersonenkennungen deterministisch,
- lässt keine ungeprüften nichtleeren Freitexte in der Projektion,
- erzeugt keine Review-Metadaten mit Roh-PII,
- bleibt ohne Review-Punkte nur dann `readyForDelivery`, wenn keine bekannten Delivery-Blocker vorliegen.

`approveAthleteDataSubjectDeliveryReview()` und die Approval-Validierung:

- akzeptieren ausschließlich Tenant-Admins für neue Freigaben,
- speichern keinen Roh-Freitext,
- binden Entscheidungen kryptografisch an den aktuellen Source-/Policy-Scope,
- sind pro Reviewer idempotent,
- bleiben DB-seitig immutable,
- invalidieren bei Source-/Review-/Vertragsdrift fail-closed.
