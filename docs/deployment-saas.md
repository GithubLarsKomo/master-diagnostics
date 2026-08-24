# SaaS-/Hosted-Modus

## Zielkonfiguration

- `DEPLOYMENT_MODE=saas`
- Identity/SSO hinter der bestehenden Provider-Abstraktion; auf der gemeinsamen Plattform kann Authentik vorgelagert werden
- PostgreSQL 18.x als verbindliche Zielpersistenz, initiale Produktionsbasis 18.6
- eigene Datenbank `master_diagnostics`
- eigene Least-Privilege-Runtime-Rolle `master_diagnostics_app`
- Plattform-Admin-Oberfläche
- mehrere logisch getrennte Tenants

Kanonischer Datenbankvertrag:

```dotenv
DATABASE_URL=postgresql://master_diagnostics_app:<runtime_secret>@postgres:5432/master_diagnostics
DB_POOL_MAX=5
```

## Netzwerk- und Datenbankgrenzen

- PostgreSQL-Port 5432 wird nicht öffentlich veröffentlicht.
- App-Zugriff erfolgt ausschließlich über das private Plattform-/Coolify-Netz.
- Externe Administration erfolgt über SSH/private Pfade oder SSH-Tunnel.
- Bei Datenbankverkehr über Hostgrenzen ist TLS zusätzlich zum privaten Netz erforderlich.
- Master Diagnostics hat keine Runtime-Rechte auf Datenbanken anderer Anwendungen.
- Direkte Cross-Database-SQL-Zugriffe und Cross-Application-Foreign-Keys sind verboten.

## Übergang von libSQL/Turso

Der bestehende libSQL-/Turso-Pfad wird nicht ungeprüft abgeschaltet. PostgreSQL wird erst autoritativ, wenn die in [ADR-0023](./adr/0023-postgresql-platform-convergence.md) und [`postgresql-convergence.md`](./postgresql-convergence.md) beschriebenen Provider-, Offline-, Backup-/Restore-, Privacy-, Migration- und Reconciliation-Gates bestanden sind.

Es gibt keinen Dual-Write-Betrieb. Während des Cutovers ist zu jedem Zeitpunkt genau ein Persistenzprovider autoritativ.

## Produktintegration

Freigegebene diagnostische Ergebnisse werden über versionierte APIs/Events veröffentlicht. Der erste Vertrag ist `diagnostic.test.released` / `diagnostic-artifact-v1`; siehe [`diagnostic-artifact-integration.md`](./diagnostic-artifact-integration.md).

Andere Produkte lesen die Master-Diagnostics-Datenbank nicht direkt.

Die konkrete Hosting-Plattform bleibt austauschbar; keine proprietären Serverless-Funktionen dürfen fachlich erforderlich sein.