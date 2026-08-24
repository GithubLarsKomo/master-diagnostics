# PostgreSQL production cutover runbook

Status: prepared and CI-qualified; execution against a real Club/Hosted deployment remains an explicit operator action.

## Invariants

- PostgreSQL 18.x is the target database; baseline is 18.6.
- No dual write is permitted.
- `infra/docker-compose.club.yml` remains the legacy libSQL rollback stack during the rollback window.
- `infra/docker-compose.club.postgres.yml` is the PostgreSQL production stack.
- The cutover must start from a write-frozen libSQL source and must reproduce the already qualified `READY_FOR_CUTOVER` rehearsal sequence.
- A mismatch in migration reconciliation, backup verification, restore reconciliation, application health, or privacy capability checks stops the procedure.

## Required secrets and host state

Create or verify:

- `.env` with `DB_ENGINE=postgres`, `DATABASE_URL=postgresql://...@postgres:5432/master_diagnostics`, `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`.
- `BETTER_AUTH_SECRET` unchanged from the current deployment.
- `/etc/master-diagnostics/backup.key`, mode `0600`, unchanged unless a separately rehearsed key rotation is intended.
- `/etc/master-diagnostics/restore-privacy-effect-journal.key` and all existing restore/privacy keys.
- writable `BACKUP_HOST_DIR`, mode `0700` or stricter.
- enough free disk for the retained legacy volume, PostgreSQL volume, final legacy backup, first PostgreSQL backup, and one isolated restore.

Do not put database or backup secrets into the repository or Compose file.

## Phase 0 — preflight

1. Confirm the current release SHA and record it in the change ticket.
2. Confirm the latest CI gates are green: PostgreSQL Qualification, Reconciliation, Backup Restore, Cutover Rehearsal, standard CI, Club Fresh Install and restore/privacy contracts.
3. Verify the PostgreSQL production Compose parses without interpolation warnings:
   `docker compose --env-file .env -f infra/docker-compose.club.postgres.yml config`.
4. Verify the legacy stack is healthy and take a normal legacy backup.
5. Confirm no restore/promotion or retention job is in progress.

## Phase 1 — write freeze and final legacy evidence

1. Announce maintenance/read-only window.
2. Stop application writers while preserving the legacy database volume. Do not destroy any volume.
3. Seal the exact libSQL database snapshot used for migration.
4. Create the final legacy backup from that sealed snapshot.
5. Verify the final backup hash equals the sealed source hash.
6. Record both SHA-256 values and timestamps.

If the hashes differ, abort and return to the legacy stack before any PostgreSQL application traffic.

## Phase 2 — prepare PostgreSQL

1. Start only PostgreSQL from the new stack:
   `docker compose --env-file .env -f infra/docker-compose.club.postgres.yml up -d postgres`.
2. Confirm `postgres` is healthy.
3. Run the PostgreSQL migrator:
   `docker compose --env-file .env -f infra/docker-compose.club.postgres.yml run --rm migrate`.
4. The target must be empty except for the generated schema/migration ledger before data migration.

## Phase 3 — one-time data migration

Run the already qualified libSQL→PostgreSQL migration against the sealed source, never the mutable legacy live volume. Require:

- reconciliation status `MATCH`;
- `tableCount == 46`;
- zero mismatches;
- critical diagnostic snapshots, interpretations, reports and audit events matching.

Store the reconciliation report with the change evidence. Any mismatch aborts the cutover.

## Phase 4 — first PostgreSQL backup and restore proof

1. Create the first encrypted PostgreSQL backup with `infra/backup/create-club-postgres-backup.sh` or the `postgres-backup` Compose profile.
2. Verify its `.sha256` sidecar.
3. Restore into an isolated PostgreSQL database/instance.
4. Reconcile source PostgreSQL vs isolated restore across all 46 tables.
5. Require `MATCH` and zero mismatches.

Do not enable production traffic without this first restore proof.

## Phase 5 — switch application traffic

1. Stop the legacy application containers; retain the libSQL volume unchanged.
2. Start PostgreSQL application services:
   `docker compose --env-file .env -f infra/docker-compose.club.postgres.yml up -d app export-cleanup retention-scan caddy`.
3. Wait for the application healthcheck.
4. Verify authentication, tenant isolation, an athlete/test read, one controlled write, and audit event creation.
5. Confirm `DB_ENGINE=postgres` from runtime configuration evidence; no libSQL service may receive application writes.
6. Run privacy capability check.

## Phase 6 — backup ownership switch

Only after PostgreSQL application health is proven:

1. Disable the legacy timer: `systemctl disable --now master-diagnostics-backup.timer`.
2. Install/enable the PostgreSQL timer: `sudo infra/backup/install-club-postgres-backup-timer.sh`.
3. Trigger one manual PostgreSQL backup service run and verify success.
4. Record timer status and newest backup checksum.

At no point may both database engines receive application writes.

## Rollback boundary

Rollback is permitted only while the retained legacy libSQL volume still represents the exact frozen pre-cutover state and before accepting business writes that cannot safely be replayed.

If PostgreSQL fails before production writes are accepted:

1. stop the PostgreSQL app stack but retain `postgres-data` for forensic evidence;
2. restore `.env`/deployment selection to the legacy libSQL stack;
3. start `infra/docker-compose.club.yml`;
4. verify application and privacy health;
5. re-enable `master-diagnostics-backup.timer` and keep the PostgreSQL timer disabled;
6. record rollback reason and evidence.

Once PostgreSQL has accepted production writes, never silently switch back to the frozen libSQL database. A post-write rollback requires an explicit reverse reconciliation/recovery plan to avoid data loss.

## Completion receipt

The operator record must include:

- release SHA;
- sealed legacy source SHA-256 and final legacy backup SHA-256;
- migration reconciliation report SHA-256;
- first PostgreSQL backup bundle/checksum;
- isolated restore reconciliation report SHA-256;
- application health timestamp;
- backup timer status;
- confirmation `dualWriteUsed=false`;
- confirmation of whether PostgreSQL accepted production writes;
- rollback-window closure timestamp.

The cutover is complete only when all evidence is retained outside mutable application volumes.
