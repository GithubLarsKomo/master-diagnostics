# PostgreSQL production cutover preparation

This change prepares, but does not execute, the production database switch.

Prepared components:

- `infra/docker-compose.club.postgres.yml`: PostgreSQL 18.6 production stack with private database networking and persistent `postgres-data` volume.
- `apps/web/Dockerfile` target `postgres-ops`: application migration/backup image with PostgreSQL 18 client.
- `.env.example`: explicit `DB_ENGINE=postgres`, database credentials, pool settings and PostgreSQL `DATABASE_URL` contract.
- `infra/backup/create-club-postgres-backup.sh`: encrypted PostgreSQL backup execution and bounded retention.
- `infra/backup/install-club-postgres-backup-timer.sh`: dedicated systemd timer, intentionally separate from the legacy libSQL timer.
- `docs/postgresql-production-cutover-runbook.md`: write-freeze, final legacy evidence, migration/reconciliation, first PostgreSQL backup/restore, traffic switch and rollback boundary.
- PostgreSQL Club production smoke CI: fail-closed env validation, empty-volume migration, app health and backup/timer verification.

The existing `infra/docker-compose.club.yml` remains unchanged as the legacy rollback stack. No dual write is introduced and this preparation does not change production traffic or a real host configuration.
