# PostgreSQL backup ownership after cutover

Use `infra/backup/create-club-postgres-backup.sh` and `infra/backup/install-club-postgres-backup-timer.sh` only after the application has switched to `DB_ENGINE=postgres` and PostgreSQL health has been proven.

The legacy `master-diagnostics-backup.timer` remains the rollback timer and must be disabled before enabling `master-diagnostics-postgres-backup.timer`. Both timers must never be active as production backup owners at the same time.

The PostgreSQL backup job uses the qualified encrypted `.pgbak` bundle format, SHA-256 sidecar verification and bounded retention from `BACKUP_RETENTION_COUNT`. The encryption key remains outside Docker volumes at `BACKUP_KEY_FILE`.

A successful backup does not by itself close the rollback window. Follow `docs/postgresql-production-cutover-runbook.md` for migration reconciliation, isolated restore proof, application health and rollback-boundary handling.
