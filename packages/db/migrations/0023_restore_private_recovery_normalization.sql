CREATE TABLE `restore_private_recovery_normalizations` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `athlete_id` text NOT NULL,
  `backup_cutoff` text NOT NULL,
  `plan_fingerprint` text NOT NULL,
  `actions_fingerprint` text NOT NULL,
  `intent_signature` text NOT NULL,
  `recovery_started_at` text NOT NULL,
  `snapshot_status` text NOT NULL,
  `action` text NOT NULL,
  `effect_basis` text NOT NULL,
  `source_db_committed_at` text NOT NULL,
  `normalized_at` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `athlete_anonymization_executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `restore_private_recovery_normalizations_subject_idx`
ON `restore_private_recovery_normalizations` (`tenant_id`, `athlete_id`);
--> statement-breakpoint
CREATE TRIGGER `restore_private_recovery_normalizations_validate_insert`
BEFORE INSERT ON `restore_private_recovery_normalizations`
BEGIN
  SELECT CASE WHEN NEW.plan_fingerprint NOT GLOB 'sha256:*'
    OR NEW.actions_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'restore private recovery normalization fingerprints are invalid') END;
  SELECT CASE WHEN NEW.intent_signature NOT GLOB 'hmac-sha256:*'
    THEN RAISE(ABORT, 'restore private recovery normalization intent signature is invalid') END;
  SELECT CASE WHEN NEW.snapshot_status NOT IN ('PREPARING', 'ARTIFACTS_STAGED')
    THEN RAISE(ABORT, 'restore private recovery normalization snapshot status is invalid') END;
  SELECT CASE WHEN NEW.action <> 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE'
    OR NEW.effect_basis <> 'POST_BACKUP_COMMITTED'
    THEN RAISE(ABORT, 'restore private recovery normalization action is invalid') END;
  SELECT CASE WHEN NEW.source_db_committed_at <= NEW.backup_cutoff
    THEN RAISE(ABORT, 'restore private recovery normalization requires a post-backup commit') END;
  SELECT CASE WHEN NEW.recovery_started_at < NEW.source_db_committed_at
    OR NEW.normalized_at < NEW.recovery_started_at
    OR NEW.created_at <> NEW.normalized_at
    THEN RAISE(ABORT, 'restore private recovery normalization chronology is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM athlete_anonymization_executions execution
    WHERE execution.id = NEW.execution_id
      AND execution.tenant_id = NEW.tenant_id
      AND execution.athlete_id = NEW.athlete_id
      AND execution.status = NEW.snapshot_status
  ) THEN RAISE(ABORT, 'matching historical anonymization execution required for restore normalization') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM restore_privacy_replay_authorizations replay
    WHERE replay.execution_id = NEW.execution_id
      AND replay.tenant_id = NEW.tenant_id
      AND replay.athlete_id = NEW.athlete_id
      AND replay.db_committed_at = NEW.source_db_committed_at
      AND replay.status = 'APPLIED'
  ) THEN RAISE(ABORT, 'applied restore privacy replay authorization required for restore normalization') END;
END;
--> statement-breakpoint
CREATE TRIGGER `restore_private_recovery_normalizations_immutable_update`
BEFORE UPDATE ON `restore_private_recovery_normalizations`
BEGIN
  SELECT RAISE(ABORT, 'restore private recovery normalizations are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `restore_private_recovery_normalizations_immutable_delete`
BEFORE DELETE ON `restore_private_recovery_normalizations`
BEGIN
  SELECT RAISE(ABORT, 'restore private recovery normalizations are immutable');
END;
