# ADR-0002: libSQL als gemeinsame Datenbankschnittstelle

- Status: **superseded for target architecture; retained for transition**
- Ursprüngliche Entscheidung: Club-Modus nutzt lokalen libSQL-Server; SaaS bevorzugt Turso Cloud. Ein Drizzle-Schema und dieselben Migrationen tragen beide Betriebsarten.
- Neue Zielentscheidung: PostgreSQL 18.x ist gemäß ADR-0023 der verbindliche Persistenzprovider für SaaS/Hosted und den autarken Club-Modus.
- Übergangsregel: Der bestehende libSQL-Provider bleibt der produktiv qualifizierte Persistenzpfad, bis alle PostgreSQL-Migrations-, Offline-, Backup-/Restore-, Privacy- und Reconciliation-Gates aus ADR-0023 nachweislich bestanden sind.
- Kein Dual Write: Während der Migration gibt es zu jedem Zeitpunkt genau einen autoritativen Persistenzprovider.

Siehe [`0023-postgresql-platform-convergence.md`](./0023-postgresql-platform-convergence.md).
