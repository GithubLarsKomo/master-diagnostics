CREATE TABLE `athlete_anonymization_executions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `athlete_id` text NOT NULL,
  `approval_id` text NOT NULL,
  `execution_version` integer NOT NULL,
  `status` text NOT NULL,
  `prepared_by_user_id` text NOT NULL,
  `prepared_at` text NOT NULL,
  `artifacts_staged_at` text,
  `db_committed_at` text,
  `completed_at` text,
  `aborted_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`approval_id`) REFERENCES `athlete_anonymization_approvals`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`prepared_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_anonymization_execution_approval_uq` ON `athlete_anonymization_executions` (`approval_id`);
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_executions_validate_insert
BEFORE INSERT ON athlete_anonymization_executions
BEGIN
  SELECT CASE WHEN NEW.execution_version <> 1
    THEN RAISE(ABORT, 'unsupported anonymization execution version') END;
  SELECT CASE WHEN NEW.status <> 'PREPARING'
    THEN RAISE(ABORT, 'anonymization execution must start in PREPARING') END;
  SELECT CASE WHEN NEW.artifacts_staged_at IS NOT NULL
    OR NEW.db_committed_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.aborted_at IS NOT NULL
    THEN RAISE(ABORT, 'anonymization execution initial timestamps are invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM athlete_anonymization_approvals approval
    WHERE approval.id = NEW.approval_id
      AND approval.tenant_id = NEW.tenant_id
      AND approval.athlete_id = NEW.athlete_id
  ) THEN RAISE(ABORT, 'matching anonymization approval required') END;
END;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_executions_monotonic_update
BEFORE UPDATE ON athlete_anonymization_executions
BEGIN
  SELECT CASE WHEN
    NEW.id IS NOT OLD.id
    OR NEW.tenant_id IS NOT OLD.tenant_id
    OR NEW.athlete_id IS NOT OLD.athlete_id
    OR NEW.approval_id IS NOT OLD.approval_id
    OR NEW.execution_version IS NOT OLD.execution_version
    OR NEW.prepared_by_user_id IS NOT OLD.prepared_by_user_id
    OR NEW.prepared_at IS NOT OLD.prepared_at
    OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'anonymization execution identity is immutable') END;

  SELECT CASE WHEN OLD.status = 'PREPARING' AND NEW.status = 'ARTIFACTS_STAGED' AND (
    NEW.artifacts_staged_at IS NULL
    OR NEW.db_committed_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.aborted_at IS NOT NULL
  ) THEN RAISE(ABORT, 'invalid ARTIFACTS_STAGED transition') END;
  SELECT CASE WHEN OLD.status = 'PREPARING' AND NEW.status = 'ABORTED' AND (
    NEW.artifacts_staged_at IS NOT OLD.artifacts_staged_at
    OR NEW.db_committed_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.aborted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid PREPARING abort transition') END;

  SELECT CASE WHEN OLD.status = 'ARTIFACTS_STAGED' AND NEW.status = 'DB_COMMITTED' AND (
    NEW.artifacts_staged_at IS NOT OLD.artifacts_staged_at
    OR NEW.db_committed_at IS NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.aborted_at IS NOT NULL
  ) THEN RAISE(ABORT, 'invalid DB_COMMITTED transition') END;
  SELECT CASE WHEN OLD.status = 'ARTIFACTS_STAGED' AND NEW.status = 'ABORTED' AND (
    NEW.artifacts_staged_at IS NOT OLD.artifacts_staged_at
    OR NEW.db_committed_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.aborted_at IS NULL
  ) THEN RAISE(ABORT, 'invalid ARTIFACTS_STAGED abort transition') END;

  SELECT CASE WHEN OLD.status = 'DB_COMMITTED' AND NEW.status = 'COMPLETED' AND (
    NEW.artifacts_staged_at IS NOT OLD.artifacts_staged_at
    OR NEW.db_committed_at IS NOT OLD.db_committed_at
    OR NEW.completed_at IS NULL
    OR NEW.aborted_at IS NOT NULL
  ) THEN RAISE(ABORT, 'invalid COMPLETED transition') END;

  SELECT CASE WHEN NOT (
    (OLD.status = 'PREPARING' AND NEW.status IN ('ARTIFACTS_STAGED', 'ABORTED'))
    OR (OLD.status = 'ARTIFACTS_STAGED' AND NEW.status IN ('DB_COMMITTED', 'ABORTED'))
    OR (OLD.status = 'DB_COMMITTED' AND NEW.status = 'COMPLETED')
  ) THEN RAISE(ABORT, 'invalid anonymization execution status transition') END;
END;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_executions_immutable_delete
BEFORE DELETE ON athlete_anonymization_executions
BEGIN
  SELECT RAISE(ABORT, 'anonymization executions are immutable evidence');
END;
