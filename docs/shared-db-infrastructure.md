# Shared database infrastructure

## Decision

The canonical hosted database platform for the Hetzner/Coolify environment is **MariaDB 11.8**. `master-diagnostics` and `sport-athlete-management-app` share the same database service and operational controls, but never the same logical database or application account.

This decision replaces Turso/libSQL as the target for the hosted `master-diagnostics` deployment. A libSQL-based standalone/club mode may remain as a compatibility deployment only while the migration is completed and verified.

## Topology

```text
Internet
  |
  v
reverse proxy / Authentik
  |                  \
  v                   v
master-diagnostics    sport-athlete-management-app
  |                   |
  +------ private application/database network ------+
                          |
                          v
                   MariaDB 11.8
                   - master_diagnostics
                   - sport_athlete

SSH administration -> Hetzner host -> database container/socket/private address
```

### Mandatory boundaries

- Do not publish MariaDB port `3306` to the public Internet.
- Application traffic reaches MariaDB only through the private Hetzner/Coolify application network.
- External database administration is performed through SSH to the Hetzner host and then through a local/private database path.
- Each application receives its own database, user and password.
- Application users have no global privileges and no privileges on the sibling application's database.
- A separate administrative account is used for migrations, restore and emergency work where elevated privileges are actually required.
- Database credentials are runtime secrets. They are not committed to either repository.

## Canonical application environment contract

Hosted deployments use the same variable names in both applications:

```dotenv
DB_HOST=shared-mariadb
DB_PORT=3306
DB_NAME=<application_database>
DB_USER=<application_user>
DB_PASSWORD=<runtime_secret>
DB_CONNECTION_LIMIT=5
```

Recommended logical names:

| Application | Database | Application user |
|---|---|---|
| master-diagnostics | `master_diagnostics` | `master_diagnostics` |
| sport-athlete-management-app | `sport_athlete` | `sport_athlete` |

`DB_HOST` is a private service/DNS name and must not resolve to a public database endpoint.

## Schema and migration rules

1. Every repository owns only its own schema and migrations.
2. Migrations are append-only after deployment; a previously applied migration is never edited.
3. A migration table records version, checksum/hash and application identity.
4. Deployment runs migrations before application traffic is switched to the new version.
5. Destructive migrations require a tested backup and explicit rollback/restore procedure.
6. Cross-application foreign keys are forbidden. Integration between applications is through versioned APIs/contracts, never direct table coupling.

## Backup and restore

The shared MariaDB service is backed up as an infrastructure concern, while each application still owns application-level retention, export and privacy semantics.

Minimum controls:

- encrypted backups at rest;
- bounded retention;
- regular restore drills;
- database-per-application restore capability;
- restore evidence and checksums;
- no reliance on an application container filesystem as the only backup location.

`master-diagnostics` has extensive libSQL-specific backup and privacy tooling. These controls must be ported and regression-tested against MariaDB before the hosted libSQL path is removed.

## Migration sequence for master-diagnostics

1. Introduce a MariaDB/Drizzle driver behind the existing database package boundary.
2. Port schema definitions from `sqlite-core` to `mysql-core` without changing domain semantics.
3. Generate a clean MariaDB baseline migration and retain the old libSQL migration history only for legacy/standalone deployments.
4. Convert DB tests to a MariaDB 11.8 CI service; do not replace database tests with mocks.
5. Port backup/restore/privacy tooling that currently assumes libSQL files.
6. Run export/import reconciliation against representative data.
7. Make MariaDB the hosted default and remove Turso from hosted deployment documentation.
8. Remove libSQL hosted support only after backup, restore and privacy acceptance checks pass.

## Non-goals

- A single shared schema for both products.
- Direct SQL reads from one application into the other application's database.
- A public database endpoint for convenience.
- Reusing one application credential across projects.

## Acceptance criteria

The infrastructure is considered aligned when both applications:

- connect to the same private MariaDB 11.8 service;
- use the canonical `DB_*` environment contract;
- use separate databases and least-privilege users;
- have migration checksum protection;
- pass integration tests against MariaDB 11.8;
- can be backed up and restored independently;
- require SSH/private-network access for database administration from outside the host environment.
