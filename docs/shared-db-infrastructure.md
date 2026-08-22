# Shared Database Infrastructure v1

**Status:** ACCEPTED  
**Effective:** 2026-08-22  
**Scope:** hosted applications on the private Hetzner/Coolify environment

## Decision

The canonical relational database platform for hosted applications is **PostgreSQL 18.x**. The initial production baseline is PostgreSQL **18.6**; patch releases may advance within major version 18 after normal backup and restore checks. PostgreSQL 19 beta releases are not production targets.

Applications share one managed PostgreSQL service/cluster and common operational controls, but **never share application credentials or application databases**. Each product owns its schema, migrations, data lifecycle and application-level privacy semantics.

This is the default for all new persistent applications. Any future exception requires an explicit repository ADR explaining why PostgreSQL is unsuitable and how the exception will be operated and backed up.

## Topology

```text
Internet
  |
  v
reverse proxy / Authentik
  |
  +--------------------+--------------------+
  |                    |                    |
  v                    v                    v
master-diagnostics     sport app            grilling 2.0 / future apps
  |                    |                    |
  +------------ private Hetzner/Coolify network ------------+
                               |
                               v
                         PostgreSQL 18.x
                         - master_diagnostics
                         - sport_athlete
                         - grilling
                         - <future app database>

External administration
  -> SSH to Hetzner host
  -> local/private PostgreSQL path or SSH tunnel
```

## Mandatory network and security boundaries

- PostgreSQL port `5432` MUST NOT be published to the public Internet.
- Application traffic reaches PostgreSQL only through the private Hetzner/Coolify network.
- Database administration from outside the host environment is performed only through SSH and a local/private path or SSH tunnel.
- Every application has its own PostgreSQL database and least-privilege runtime role.
- Runtime roles receive no privileges on sibling application databases.
- Migration/restore privileges use a separate operator or migration role; applications do not run as database superusers.
- `PUBLIC` schema privileges are reduced to the minimum required by the application.
- Secrets are injected at runtime and are never committed to a repository.
- If database traffic crosses Hetzner hosts rather than remaining on one local container network, TLS is required in addition to the private network boundary.

## Canonical application connection contract

The target contract for PostgreSQL applications is:

```dotenv
DATABASE_URL=postgresql://<app_user>:<runtime_secret>@postgres:5432/<app_database>
DB_POOL_MAX=5
```

`DATABASE_URL` is a secret. The host name must resolve only inside the private application network. Applications may expose additional tuning variables, but they must not redefine database identity or create a second competing connection contract.

Recommended logical names:

| Application | Database | Runtime role |
|---|---|---|
| master-diagnostics | `master_diagnostics` | `master_diagnostics_app` |
| sport-athlete-management-app | `sport_athlete` | `sport_athlete_app` |
| grilling 2.0 | `grilling` | `grilling_app` |
| future application | dedicated database | dedicated `<app>_app` role |

## Current provider matrix and migration policy

| Application | Current persistence | Target | Policy |
|---|---|---|---|
| master-diagnostics | libSQL/SQLite | PostgreSQL 18.x | **Retain libSQL for now.** Migrate only after the existing backup, restore, privacy and offline contracts have PostgreSQL-equivalent evidence. |
| sport-athlete-management-app | MariaDB 11.8 | PostgreSQL 18.x | MariaDB is transitional. Migrate in a dedicated provider PR with PostgreSQL integration tests and data reconciliation. |
| grilling | versioned JSON/files today | PostgreSQL 18.x for Grilling 2.0 persistence | The first DB-backed release starts directly on PostgreSQL; do not introduce a temporary MariaDB layer. |
| future apps | n/a | PostgreSQL 18.x | PostgreSQL is the default from the first persistent release. |

Provider-specific features that make an already planned migration harder should not be added without a documented reason.

## Schema and migration rules

1. Every repository owns only its own database schema and migrations.
2. Cross-application foreign keys and direct cross-application SQL are forbidden.
3. Integration between products uses versioned APIs/contracts, not sibling database access.
4. Applied migrations are immutable and append-only.
5. A migration ledger records migration identity and checksum/hash.
6. Deployment runs migrations before new application traffic is switched to the release.
7. Destructive changes require a verified backup and an explicit rollback/restore path.
8. PostgreSQL migrations should be transactional where PostgreSQL permits it.
9. Application timestamps use timezone-aware PostgreSQL types where an instant is represented; local calendar dates remain `date` values.
10. Structured mutable payloads should prefer `jsonb` over serialized text when queryability or validation benefits from native JSON.

## Extensions and analytical workloads

PostgreSQL extensions are enabled per need, not globally by default.

- `pgcrypto` may be enabled where database-side UUID/crypto functions are justified.
- `vector`/pgvector may be enabled for applications that genuinely need vector similarity search.
- An extension must not create an implicit dependency for unrelated application databases.

## Backup and restore baseline

The PostgreSQL service is backed up as shared infrastructure while application-level retention/privacy remains repository-owned.

Minimum controls:

- encrypted backups at rest;
- independent logical backup/restore capability for every application database;
- PostgreSQL roles/ownership captured separately from application data dumps;
- checksums and restore evidence;
- bounded retention defined by the applicable application policy;
- regular restore drills into an isolated target;
- no reliance on an application container filesystem as the only backup location;
- point-in-time recovery may be added at the PostgreSQL service layer and must not replace per-application restore verification.

## Migration gates

### Sport app: MariaDB -> PostgreSQL

The provider switch is complete only when:

1. persistence code uses a PostgreSQL driver;
2. MariaDB-specific SQL (`ON DUPLICATE KEY`, `ENUM`, `DATETIME(6)`, `AUTO_INCREMENT`, `FOR UPDATE` assumptions) is ported deliberately;
3. migrations create a clean PostgreSQL schema and remain checksum-protected;
4. CI runs the full integration suite against PostgreSQL 18;
5. representative MariaDB data is exported, imported and reconciled record-for-record for required entities;
6. backup and restore of `sport_athlete` is demonstrated;
7. production configuration uses the canonical `DATABASE_URL` contract.

### Masters Diagnostics: libSQL -> PostgreSQL

The provider switch is intentionally later. It is complete only when:

1. the Drizzle schema/provider is ported without changing domain semantics;
2. DB tests run against PostgreSQL rather than mocks;
3. offline/sync behavior remains equivalent;
4. backup, restore, retention, export/import and privacy reconciliation have PostgreSQL-native implementations or equivalent controls;
5. the existing fail-closed privacy and restore contracts are re-qualified;
6. representative libSQL data is migrated and reconciled;
7. libSQL hosted support is removed only after all acceptance gates pass.

### Grilling 2.0

The first persistent version uses PostgreSQL directly and must include:

- versioned project/grilling definitions;
- versioned rounds/questions;
- append-only/version-aware answers and history;
- migration checksum protection;
- project isolation in the data model;
- backup/restore readiness before production data becomes authoritative.

## Non-goals

- one shared schema for all products;
- one application account reused by multiple products;
- direct SQL joins between product databases;
- a public database endpoint for convenience;
- forcing Masters Diagnostics off libSQL before its existing operational guarantees are reproduced;
- keeping MariaDB as a second long-term hosted platform solely for the Sport app.

## Acceptance criteria for platform convergence

The infrastructure is considered fully converged when persistent hosted applications:

- use the same private PostgreSQL 18.x service/cluster;
- have separate databases and least-privilege runtime roles;
- use the canonical PostgreSQL connection contract;
- have immutable/checksummed migrations;
- pass real PostgreSQL integration tests;
- can be backed up and restored independently;
- require SSH/private-network access for external database administration;
- do not depend on direct access to sibling application databases.
