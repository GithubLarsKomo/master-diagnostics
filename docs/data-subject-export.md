# Betroffenenexport

## Ziel

Der Betroffenenexport ist ein eigener DSGVO-/Datenschutzpfad und **kein** vollständiger Tenant-Portabilitätsexport. Er sammelt ausschließlich die fachlichen Daten eines einzelnen Athleten innerhalb genau eines Tenants.

Der erste Implementierungsschritt ist bewusst read-only. Er erzeugt noch kein automatisch zustellbares Paket und schreibt deshalb auch noch keinen Export-Audit. Die spätere administrative Erzeugung/Auslieferung muss gemäß `SPEC.md` §33.1 als Exportereignis auditiert werden.

## Versionierter Vertrag

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

## Drittpersonen und Auslieferung

Guardian-Kontaktdaten und Trainerreferenzen können Rechte Dritter berühren. Der Source ist deshalb noch nicht gleichbedeutend mit einem direkt auslieferbaren Betroffenenpaket. Der nächste Slice muss die administrative Erzeugung/Auslieferung mit explizitem Review-/Redaktionsvertrag, Export-Audit und Report-Artefaktbehandlung ergänzen.

## Sicherheitsinvarianten

`getAthleteDataSubjectExportSource()`:

- ist vollständig read-only,
- liefert `null`, wenn der Athlet nicht zum angefragten Tenant gehört,
- fragt jede Tabelle tenantgebunden ab,
- übernimmt keine tenantweiten Tabellen aus dem Portabilitätsexport,
- mutiert weder Fachdaten noch Audit-Log,
- liefert externe Report-Artefakte nur als technische Referenzen.
