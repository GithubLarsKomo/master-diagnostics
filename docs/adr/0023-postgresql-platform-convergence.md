# ADR-0023: PostgreSQL 18.x als Zielplattform

- Status: **accepted**
- Datum: 2026-08-24
- Supersedes für die Zielarchitektur: ADR-0002

## Kontext

Die gehosteten Anwendungen der Plattform konvergieren auf PostgreSQL 18.x als gemeinsame relationale Betriebsplattform. Master Diagnostics verwendet heute produktiv qualifizierte libSQL-/SQLite-Pfade mit umfangreichen Offline-, Backup-, Restore- und Privacy-Verträgen. Ein reiner Providerwechsel ohne erneute Qualifikation würde diese Garantien gefährden.

Gleichzeitig soll Master Diagnostics mit Sport Athlete Management und weiteren Plattformprodukten auf einer gemeinsamen privaten PostgreSQL-Infrastruktur betrieben werden, ohne Datenbanken oder Anwendungskonten zwischen Produkten zu teilen.

## Entscheidung

1. PostgreSQL **18.x** ist der verbindliche Zielprovider für Master Diagnostics. Die initiale Produktionsbasis ist PostgreSQL **18.6**.
2. Hosted/SaaS verwendet eine eigene Datenbank `master_diagnostics` und die Least-Privilege-Runtime-Rolle `master_diagnostics_app` auf dem privaten Plattformcluster.
3. Der autarke Club-Modus verwendet langfristig denselben PostgreSQL-Provider in einem lokalen Container mit persistentem Volume und bleibt ohne externe Cloud-Dienste betreibbar.
4. Der bestehende libSQL-Provider bleibt als Übergangsprovider erhalten, bis sämtliche Migrations-Gates erfüllt sind. Bis dahin bleibt er für bestehende Club-/Hosted-Pfade autoritativ.
5. Es gibt keinen Dual-Write-Betrieb zwischen libSQL und PostgreSQL.
6. `DATABASE_URL` ist der kanonische PostgreSQL-Verbindungsvertrag; `DB_POOL_MAX` begrenzt den Anwendungspool.
7. Port 5432 wird nicht öffentlich veröffentlicht. Externe Administration erfolgt ausschließlich über private Netzwerkpfade oder SSH-Tunnel. Datenbankverkehr über Hostgrenzen verwendet zusätzlich TLS.
8. Migrationen sind append-only und checksum-geschützt; PostgreSQL-Migrationen werden transaktional ausgeführt, soweit PostgreSQL dies erlaubt.
9. PostgreSQL-Zeitpunkte verwenden `timestamptz`, lokale Kalendertage `date`; strukturierte Payloads bevorzugen `jsonb`, sofern sinnvoll.
10. Präzisionskritische Messwerte behalten die bestehende Integer-Skalierung; ein Providerwechsel ändert keine diagnostische Semantik.

## Produktisolation

Die gemeinsame PostgreSQL-Plattform ist gemeinsame **Infrastruktur**, keine gemeinsame Anwendungsdatenbank.

Verboten sind:

- gemeinsame Runtime-Credentials mehrerer Produkte;
- direkte SQL-Abfragen auf Datenbanken anderer Produkte;
- Cross-Application-Foreign-Keys;
- ein gemeinsames fachliches Schema als Integrationsmechanismus.

Produktintegration erfolgt ausschließlich über versionierte APIs, Events und Verträge. Master Diagnostics veröffentlicht nur freigegebene diagnostische Ergebnisse als versionierte Diagnostic Artifacts. Die erste kanonische Ereignisgrenze ist `diagnostic.test.released` mit `diagnostic-artifact-v1`.

## Migrations-Gates

Der PostgreSQL-Cutover ist erst freigegeben, wenn alle folgenden Nachweise vorliegen:

1. Das Drizzle-Schema und der Datenbankprovider sind auf PostgreSQL portiert, ohne Domain-Semantik oder diagnostische Ergebnisse zu verändern.
2. Datenbanktests laufen gegen echtes PostgreSQL 18.x, nicht ausschließlich gegen Mocks.
3. Offline-Synchronisation, `operation_id`-Idempotenz, `expected_version`, Konfliktbehandlung und atomare Auditierung sind unter PostgreSQL äquivalent nachgewiesen.
4. Backup, Restore, Retention, Export/Import und Privacy-Reconciliation besitzen PostgreSQL-native oder gleichwertige Implementierungen.
5. Die bestehenden fail-closed Privacy-Capability- und Restore-Verträge sind unter PostgreSQL requalifiziert.
6. Repräsentative libSQL-Daten wurden in PostgreSQL migriert und fachlich wie technisch reconciled.
7. Ein Cutover-Test umfasst Source-Backup, Migration, Reconciliation, erstes PostgreSQL-Backup, Restore in ein isoliertes Ziel und authentifizierte End-to-End-Smoke-Tests.
8. Erst nach erfolgreicher Abnahme wird libSQL aus dem regulären Hosted-/Club-Runtime-Pfad entfernt.

## Konsequenzen

- Der aktuelle libSQL-Code wird durch diese ADR nicht sofort entfernt.
- Neue provider-spezifische libSQL-Abhängigkeiten, die die geplante Migration erschweren, benötigen eine explizite Begründung.
- Neue Persistenzfunktionen sollen PostgreSQL-Kompatibilität als Ziel berücksichtigen.
- Der Club-Modus verliert keine Offline-/Autarkie-Anforderung; PostgreSQL läuft dort lokal.
- Backup-/Restore- und Privacy-Evidenz ist ein Deployment-Gate, kein nachgelagerter Betriebswunsch.
- Master Diagnostics und Sport Athlete Management bleiben fachlich getrennte Bounded Contexts.

## Referenzen

- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
- [`../postgresql-convergence.md`](../postgresql-convergence.md)
- [`../diagnostic-artifact-integration.md`](../diagnostic-artifact-integration.md)
- ADR-0002 als historische/transitionale Providerentscheidung
