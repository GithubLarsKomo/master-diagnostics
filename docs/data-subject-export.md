# Betroffenenexport

## Ziel

Der Betroffenenexport ist ein eigener DSGVO-/Datenschutzpfad und **kein** vollständiger Tenant-Portabilitätsexport. Er sammelt ausschließlich die fachlichen Daten eines einzelnen Athleten innerhalb genau eines Tenants, entfernt bekannte Drittpersonenkennungen, erzwingt eine explizite administrative Prüfung von Freitexten und liefert den freigegebenen Stand über ein kurzlebiges, verschlüsseltes Einmal-Downloadpaket aus.

Der Ablauf ist in mehrere getrennte Verträge zerlegt. Read-only Source, Privacy-Projection, Review-Approval, reviewed Snapshot und Paketvorbereitung verändern keine Fachdaten. Erst die administrative Paketerzeugung persistiert ein verschlüsseltes Artefakt und schreibt den Export-Audit; der erfolgreiche Einmal-Download schreibt einen separaten Download-Audit.

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

Audit-Logs werden nicht pauschal in die zustellbare Datenkopie aufgenommen, weil sie Identitäten und Rechte Dritter enthalten können. Die Audit-Privacy-Verarbeitung bleibt ein eigener kontrollierter Compliance-Pfad.

## Report-Artefakte

`report_versions` werden als fachliche Datensätze exportiert. Zusätzlich liefert der Source für jede Berichtsversion eine externe Referenz mit:

- Report-Version-ID
- `storageReference`
- Medientyp `application/pdf`

Der DB-Source liest keine Dateien. Erst die Paketvorbereitung lädt die tatsächlich vorhandenen PDFs aus dem Report-Storage und verifiziert ihre Integrität.

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

Damit kann kein unreviewter Freitext versehentlich in ein Betroffenenpaket gelangen.

## Administrative Review-/Freigabe

Migration `0019_data_subject_delivery_approvals` und `approveAthleteDataSubjectDeliveryReview()` bilden einen separaten, unveränderlichen Freigabevertrag. Die Freigabe autorisiert ausschließlich, welche der aktuell inventarisierten Freitextfelder im reviewed Delivery-Snapshot übernommen oder redigiert werden dürfen.

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

Der geprüfte Freitext selbst wird **nicht** in der Approval und nicht im Approval-Audit gespeichert. `INCLUDE_ORIGINAL` bedeutet nur, dass der spätere Paketierungsschritt den dann noch aktuellen Rohwert nach erneuter Validierung übernehmen darf.

### Fingerprint-Bindung und Drift

Der Source-Fingerprint bindet:

- die vollständigen aktuellen fachlichen Source-Daten,
- Report-Artefaktreferenzen,
- Source-Schema- und Delivery-Policy-Version,
- automatische Drittpersonen-Redaktionen,
- das vollständige aktuelle Review-Item-Set.

Der Decision-Fingerprint bindet die normalisierte Entscheidungsliste. Jede Änderung des fachlichen Source, des Review-Scopes oder der Vertragsversion macht eine bestehende Freigabe für die Paketierung ungültig.

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

Wiederholte Erzeugung aus identischem Source und identischer Approval liefert denselben reviewed Fingerprint. Die Snapshot-Erzeugung ist read-only.

## Verifiziertes Paketmanifest

`prepareAthleteDataSubjectDeliveryPackage()` bildet den letzten read-only Vorbau vor der tatsächlichen Auslieferung. Der Service erzeugt einen In-Memory-Paketkandidaten aus dem frisch validierten reviewed Snapshot und den zugehörigen Report-PDFs.

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

Die bereits verifizierten PDF-Bytes werden im vorbereiteten Paketkandidaten gehalten. Der Writer liest die Reports nach dieser Verifikation nicht erneut aus dem Storage.

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

Über diesen Manifest-Core wird zusätzlich ein deterministischer `manifestFingerprint` gebildet. `manifest.json` wird aus dem vollständigen Manifest vorbereitet.

## Persistiertes verschlüsseltes Auslieferungspaket

`createDataSubjectDeliveryPackage()` erzeugt aus den bereits verifizierten Bytes ein deterministisches TAR-Dateiset und persistiert es ausschließlich **verschlüsselt**.

### Archivinhalt

Das TAR enthält:

- `manifest.json`
- `data.json`
- die im Manifest gebundenen `reports/NNNN.pdf`

TAR-Pfade werden auf einen engen sicheren Zeichensatz geprüft; absolute Pfade, `..` und doppelte Einträge werden verworfen.

### Verschlüsselung und Token

- Archivversion: `1`
- Dateierweiterung im privaten Storage: `.mdse`
- Formatpräfix: `MDS1`
- Verschlüsselung: AES-GCM
- zufällige 96-Bit-IV
- Additional Authenticated Data bindet Paket-ID und `manifestFingerprint`
- der 256-Bit-Bearer-Token wird zufällig erzeugt
- der AES-Schlüssel wird deterministisch aus dem Token abgeleitet und **nicht** gespeichert
- in der DB wird nur der SHA-256-Hash des Tokens gespeichert
- die verschlüsselten Bytes erhalten zusätzlich einen eigenen SHA-256-Pakethash

Standard-TTL ist 24 Stunden; der Writer erlaubt höchstens sieben Tage. Ungültige oder nichtpositive TTLs werden abgewiesen.

Migration `0020_data_subject_delivery_packages` schützt die Paketmetadaten. Nach Erstellung sind technische Identität, Scope, Token-Hash, Storage-Referenz, Paket-Hash und Ablaufzeit unveränderlich; einzig der atomare One-Time-Consume-Übergang darf `downloaded_at` setzen.

Schlägt die DB-Persistierung nach erfolgreicher Dateierzeugung fehl, wird die verschlüsselte Datei wieder entfernt. Schlägt auch dieser Cleanup fehl, bleibt der kombinierte Fehler sichtbar.

## Administrative HTTP-Erzeugung

`POST /api/data-subject/export` ist die administrative Erzeugungsgrenze.

Voraussetzungen:

- authentifizierter Tenant-Kontext,
- Rolle `TENANT_ADMIN`,
- Request mit `athleteId`, `approvalId` und Passwort,
- erfolgreiche Passwort-Reauthentisierung,
- aktuell gültige, fingerprintgebundene Delivery-Approval.

Die Approval wird vor dem Writer geprüft. Scheitert der Writer nach positiver Vorprüfung, wird die Approval erneut validiert: Source-/Approval-Drift wird als `409` behandelt; echte Storage-/DB-/Writerfehler bleiben `500`.

Eine erfolgreiche `201`-Antwort enthält ausschließlich technische Paketmetadaten sowie den Bearer-Token:

- `packageId`
- `expiresAt`
- `manifestFingerprint`
- `packageSha256`
- tokenfreien `downloadEndpoint`
- `tokenType: Bearer`
- `downloadToken`

Der Token wird **nicht** in eine URL oder Query eingebettet. Antworten verwenden `private, no-store`, `Pragma: no-cache`, `nosniff` und `no-referrer`.

Die erfolgreiche Erzeugung schreibt `athlete.data_subject_export_created` mit technischen Paket-/Fingerprint-Metadaten, aber ohne Token oder Subject-PII.

## Einmal-Download

`GET /api/data-subject/export/download` akzeptiert den Token ausschließlich als

```http
Authorization: Bearer <token>
```

Query- oder URL-Tokens werden nicht verwendet.

Der Downloadpfad:

1. hasht den Bearer-Token,
2. sucht genau ein nicht konsumiertes, noch nicht abgelaufenes Paket,
3. lädt die verschlüsselten `.mdse`-Bytes,
4. prüft den gespeicherten Paket-Hash,
5. entschlüsselt und authentifiziert das Archiv mit dem Token,
6. führt den atomaren DB-Consume aus,
7. liefert das TAR genau einmal aus.

Unbekannte, abgelaufene und bereits konsumierte Tokens werden absichtlich als gleiche leere `404` behandelt. Ein manipulierter oder inkonsistenter Storage-Inhalt wird nicht konsumiert und führt fail-closed zum Fehler.

Erfolgreiche Downloads liefern:

- `Content-Type: application/x-tar`
- PII-freien UUID-basierten Dateinamen
- `Cache-Control: private, no-store, max-age=0`
- `Pragma: no-cache`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

Der atomare Consume setzt `downloaded_at` nur für den ersten Gewinner. Parallelversuche können daher höchstens einen erfolgreichen Download erzeugen. In derselben DB-Transaktion wird `athlete.data_subject_export_downloaded` geschrieben; Token und Subject-PII werden nicht auditiert.

## Anonymisierung und Lifecycle

Ein persistiertes `.mdse` kann auch nach Download oder Ablauf noch personenbezogene Pre-Anonymisierungsdaten enthalten. Deshalb gehört **jedes** `athlete_data_subject_delivery_packages` des Athleten zum irreversiblen Anonymisierungs-Scope.

Policy `1.6.0` und Migration `0021_data_subject_anonymization_artifacts` integrieren diese Pakete als `DATA_SUBJECT_EXPORT` in das durable Anonymisierungs-Manifest:

- alle athletenbezogenen `.mdse`-Referenzen werden in der Preview inventarisiert,
- ältere Anonymisierungs-Approvals werden durch den Policy-Versionssprung invalidiert,
- die Dateien werden vor DB-Commit quarantänisiert,
- der aktuelle Paket-Scope muss unmittelbar vor dem Commit exakt dem Manifest entsprechen,
- die Paketzeilen werden in derselben irreversiblen DB-Transaktion entfernt,
- die Dateien werden erst nach `DB_COMMITTED` endgültig gepurged,
- bei Fehlern vor dem Commit werden sie restauriert.

### Normaler Lifecycle-Cleanup

Außerhalb einer Athletenanonymisierung entfernt `cleanupUnavailableAthleteDataSubjectDeliveryPackages()` Pakete, deren Capability nicht mehr auslieferbar ist. Kandidat ist ein Paket genau dann, wenn mindestens eine Bedingung erfüllt ist:

- `downloaded_at IS NOT NULL`, oder
- `expires_at <= assessedAt`.

Noch nicht konsumierte und noch nicht abgelaufene Pakete bleiben unangetastet. Die Kandidatenprojektion enthält nur Paket-ID, Tenant-/Athlete-ID, `storage_reference`, `expires_at` und `downloaded_at`; Token-, Manifest- und Pakethashes werden dem Maintenance-Pfad nicht ausgehändigt.

Für jeden Kandidaten gilt fail-closed:

1. `PREPARING`-/`ARTIFACTS_STAGED`-Anonymisierung im Tenant prüfen,
2. bei aktiver Execution den Kandidaten überspringen,
3. verschlüsselte `.mdse`-Datei entfernen,
4. erst danach die exakt über Tenant, Athlete und Paket-ID gebundene DB-Zeile entfernen.

Schlägt die Dateilöschung fehl, bleibt die DB-Zeile stehen und der Cleanup kann später wiederholt werden. Der dauerhafte Export-/Download-Audit wird nicht entfernt.

Der Maintenance-Befehl lautet:

```bash
pnpm data-subject-delivery:cleanup
```

`DATA_SUBJECT_DELIVERY_PACKAGE_ROOT` setzt den Storage-Root. Für reproduzierbare Tests oder kontrollierte Betriebsaufrufe kann `DATA_SUBJECT_DELIVERY_CLEANUP_NOW` einen ISO-8601-Prüfzeitpunkt vorgeben. Der produktive Scheduler für wiederkehrende Maintenance-Aufrufe bleibt Teil der allgemeinen Deployment-/Betriebsplanung.

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

`buildAthleteDataSubjectReviewedDeliverySnapshot()` und `prepareAthleteDataSubjectDeliveryPackage()`:

- nutzen nur frisch validierte Approvals,
- re-fingerprinten den tatsächlich verwendeten Source,
- können ausschließlich exakt freigegebene Freitextfelder wiederherstellen,
- bewahren strukturierte Drittpersonenredaktionen,
- verifizieren die tatsächlichen PDF-Bytes gegen immutable Content-Hashes,
- binden Daten, Reports und Fingerprints deterministisch im Manifest.

Persistenz, HTTP-Auslieferung und Cleanup:

- speichern weder Bearer-Token noch abgeleiteten Verschlüsselungsschlüssel,
- geben den Token nur an der administrativen Erzeugungsgrenze zurück,
- transportieren den Token nicht in URL/Query,
- liefern Paketbytes höchstens einmal aus,
- unterscheiden extern nicht zwischen unbekannt, abgelaufen und bereits konsumiert,
- schreiben getrennte PII-arme Erzeugungs- und Download-Audits,
- integrieren verbliebene `.mdse`-Pakete in den irreversiblen Athleten-Scope,
- entfernen im normalen Lifecycle nur bereits konsumierte oder abgelaufene Pakete,
- entfernen die Datei vor der technischen DB-Zeile und pausieren bei aktiver Anonymisierung.
