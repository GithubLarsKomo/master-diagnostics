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

## Reviewed Delivery-Snapshot

`buildAthleteDataSubjectReviewedDeliverySnapshot()` erzeugt nach einer gültigen Approval die versionierte In-Memory-Stufe `masters-data-subject-reviewed-delivery-v1`.

Der Ablauf ist bewusst zweifach fail-closed:

1. Die Approval wird vollständig gegen den aktuellen Source und die aktuelle Policy revalidiert.
2. Anschließend wird genau der Source, aus dem der Snapshot tatsächlich gebaut wird, **noch einmal** mit demselben Source-Fingerprint-Vertrag gehasht und gegen die Approval geprüft.

Damit kann ein Source-Wechsel zwischen Approval-Validierung und Snapshot-Bildung nicht unbemerkt einen anderen Freitext in eine `INCLUDE_ORIGINAL`-Entscheidung einschleusen.

Für jeden freigegebenen Review-Punkt gilt:

- `INCLUDE_ORIGINAL`: der aktuelle Rohwert des exakt gebundenen Section-/Row-/Feld-Schlüssels wird übernommen,
- `REDACT`: der Wert wird deterministisch durch `[REVIEW_REDACTED]` ersetzt.

Die bereits automatisch erzeugten `[THIRD_PARTY_REDACTED]`-Redaktionen bleiben unverändert bestehen. Im reviewed Snapshot darf kein offener `[REVIEW_REQUIRED]`-Punkt verbleiben.

Der Snapshot enthält zusätzlich:

- Approval-ID,
- Source-Fingerprint,
- Decision-Fingerprint,
- einen eigenen SHA-256-`reviewedFingerprint` über den vollständigen reviewed Source.

Wiederholte Erzeugung aus identischem Source und identischer Approval liefert denselben reviewed Fingerprint. Die Snapshot-Erzeugung ist read-only und erzeugt bewusst noch kein weiteres Audit-Ereignis.

## Verifiziertes Paketmanifest

`prepareAthleteDataSubjectDeliveryPackage()` bildet den letzten read-only Vorbau vor einer tatsächlichen Auslieferung. Der Service erzeugt einen in-memory Paketkandidaten aus dem frisch validierten reviewed Snapshot und den zugehörigen Report-PDFs.

Version des Manifests: `masters-data-subject-package-manifest-v1`.

### `data.json`

Der vollständige reviewed Snapshot wird deterministisch als `data.json` mit abschließendem Newline serialisiert und SHA-256-gehasht. Das Manifest bindet Hash und Byte-Länge dieser Datei.

### Report-PDF-Integrität

Für jede im reviewed Snapshot gebundene Report-Artefaktreferenz gilt fail-closed:

- genau eine passende `report_versions`-Zeile muss vorhanden sein,
- Report-Version-ID und `storage_reference` müssen exakt übereinstimmen,
- `content_hash` muss ein gültiger `sha256:<64 hex>`-Wert sein,
- die tatsächlich aus dem Report-Storage gelesenen PDF-Bytes werden SHA-256-gehasht,
- der tatsächliche Hash muss bytegenau dem unveränderlichen `report_versions.content_hash` entsprechen.

Eine fehlende Datei, ein ungültiger gespeicherter Hash oder eine Hash-Abweichung bricht die Vorbereitung vollständig ab.

Die bereits verifizierten PDF-Bytes werden im vorbereiteten Paketkandidaten gehalten. Ein späterer Writer darf die Reports nicht nach der Verifikation erneut aus dem Storage lesen, weil dies die Bindung zwischen geprüften und tatsächlich ausgelieferten Bytes aufbrechen würde.

### Paketpfade und Manifest-Bindung

Interne Storage-Referenzen werden nicht als Paketpfade verwendet. Reports erhalten nach stabiler Sortierung deterministische Namen:

- `reports/0001.pdf`
- `reports/0002.pdf`
- usw.

Das Manifest bindet:

- Approval-ID,
- Source-Fingerprint,
- Decision-Fingerprint,
- reviewed Fingerprint,
- `data.json`,
- jede Report-Version-ID,
- Paketpfad und Medientyp,
- SHA-256 und Byte-Länge jeder Datei.

Über diesen Manifest-Core wird zusätzlich ein eigener deterministischer `manifestFingerprint` gebildet. `manifest.json` wird aus dem vollständigen Manifest vorbereitet.

Die Paketvorbereitung bleibt read-only und schreibt bewusst noch keinen Export-Audit, weil weder ein dauerhaftes Paket erzeugt noch eine Datei an einen Betroffenen ausgeliefert wurde.

## Noch keine Auslieferung

Source, Delivery-Projection, Review-Approval, reviewed Snapshot und Paketmanifest zusammen:

- erzeugen noch kein dauerhaftes Downloadpaket oder Archiv,
- veröffentlichen keine Web- oder Download-Route,
- schreiben noch keinen finalen Export-/Download-Audit.

Der nächste und abschließende Betroffenenexport-Slice muss aus `manifest.json`, `data.json` und den **bereits verifizierten** PDF-Bytes ein persistiertes, tenantgebundenes Auslieferungspaket erzeugen und administrative Erzeugung sowie Download mit den spezifizierten Export-/Download-Audits absichern.

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

`buildAthleteDataSubjectReviewedDeliverySnapshot()`:

- nutzt nur frisch validierte Approvals,
- re-fingerprintet den tatsächlich verwendeten Source,
- kann ausschließlich exakt freigegebene Freitextfelder wiederherstellen,
- ersetzt `REDACT` deterministisch,
- bewahrt strukturierte Drittpersonenredaktionen,
- ist read-only und liefert einen eigenen deterministischen Snapshot-Fingerprint.

`prepareAthleteDataSubjectDeliveryPackage()`:

- verwendet nur frisch validierte reviewed Snapshots,
- nimmt nur Reports mit exakt passender Report-Version und Storage-Referenz auf,
- verifiziert die tatsächlichen PDF-Bytes gegen den unveränderlichen Content-Hash,
- hält exakt die verifizierten Bytes für den späteren Writer fest,
- erzeugt deterministische Paketpfade, Datei-Hashes und einen Manifest-Fingerprint,
- mutiert weder Fachdaten noch Audit-Log und stellt selbst noch nichts aus.
