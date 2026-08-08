CREATE TABLE `restore_privacy_replay_authorizations` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `athlete_id` text NOT NULL,
  `approval_id` text NOT NULL,
  `deletion_request_id` text NOT NULL,
  `execution_version` integer NOT NULL,
  `policy_version` text NOT NULL,
  `scope_fingerprint` text NOT NULL,
  `capability_fingerprint` text NOT NULL,
  `db_committed_at` text NOT NULL,
  `status` text NOT NULL,
  `applied_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `restore_privacy_replay_authorizations_subject_idx`
ON `restore_privacy_replay_authorizations` (`tenant_id`, `athlete_id`, `status`);
--> statement-breakpoint
CREATE TRIGGER `restore_privacy_replay_authorizations_validate_insert`
BEFORE INSERT ON `restore_privacy_replay_authorizations`
BEGIN
  SELECT CASE WHEN NEW.execution_version < 1
    THEN RAISE(ABORT, 'restore privacy replay execution version must be positive') END;
  SELECT CASE WHEN NEW.scope_fingerprint NOT GLOB 'sha256:*'
    OR NEW.capability_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'restore privacy replay fingerprints are invalid') END;
  SELECT CASE WHEN NEW.status <> 'ACTIVE' OR NEW.applied_at IS NOT NULL
    THEN RAISE(ABORT, 'restore privacy replay authorization must start ACTIVE') END;
END;
--> statement-breakpoint
CREATE TRIGGER `restore_privacy_replay_authorizations_protect_update`
BEFORE UPDATE ON `restore_privacy_replay_authorizations`
BEGIN
  SELECT CASE WHEN OLD.execution_id IS NOT NEW.execution_id
    OR OLD.tenant_id IS NOT NEW.tenant_id
    OR OLD.athlete_id IS NOT NEW.athlete_id
    OR OLD.approval_id IS NOT NEW.approval_id
    OR OLD.deletion_request_id IS NOT NEW.deletion_request_id
    OR OLD.execution_version IS NOT NEW.execution_version
    OR OLD.policy_version IS NOT NEW.policy_version
    OR OLD.scope_fingerprint IS NOT NEW.scope_fingerprint
    OR OLD.capability_fingerprint IS NOT NEW.capability_fingerprint
    OR OLD.db_committed_at IS NOT NEW.db_committed_at
    OR OLD.created_at IS NOT NEW.created_at
    THEN RAISE(ABORT, 'restore privacy replay authorization identity is immutable') END;
  SELECT CASE WHEN OLD.status <> 'ACTIVE'
    OR NEW.status <> 'APPLIED'
    OR NEW.applied_at IS NULL
    OR NEW.updated_at <> NEW.applied_at
    THEN RAISE(ABORT, 'restore privacy replay authorization may only transition ACTIVE to APPLIED') END;
END;
--> statement-breakpoint
CREATE TRIGGER `restore_privacy_replay_authorizations_immutable_delete`
BEFORE DELETE ON `restore_privacy_replay_authorizations`
BEGIN
  SELECT RAISE(ABORT, 'restore privacy replay authorizations are immutable');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `report_versions_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `report_versions_immutable_delete`
BEFORE DELETE ON `report_versions`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM athlete_anonymization_execution_artifacts artifact
    INNER JOIN athlete_anonymization_executions execution
      ON execution.id = artifact.execution_id
      AND execution.tenant_id = artifact.tenant_id
    INNER JOIN tests athlete_test
      ON athlete_test.id = OLD.test_id
      AND athlete_test.tenant_id = OLD.tenant_id
    WHERE artifact.tenant_id = OLD.tenant_id
      AND artifact.kind = 'REPORT'
      AND artifact.storage_reference = OLD.storage_reference
      AND execution.athlete_id = athlete_test.athlete_id
      AND execution.status = 'ARTIFACTS_STAGED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM restore_privacy_replay_authorizations replay
    INNER JOIN tests athlete_test
      ON athlete_test.id = OLD.test_id
      AND athlete_test.tenant_id = OLD.tenant_id
    WHERE replay.tenant_id = OLD.tenant_id
      AND replay.athlete_id = athlete_test.athlete_id
      AND replay.status = 'ACTIVE'
  ) THEN RAISE(ABORT, 'report versions are immutable outside staged anonymization or restore privacy replay') END;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `test_plan_snapshots_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `test_plan_snapshots_immutable_delete`
BEFORE DELETE ON `test_plan_snapshots`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM athlete_anonymization_executions execution
    INNER JOIN tests athlete_test
      ON athlete_test.tenant_id = execution.tenant_id
      AND athlete_test.athlete_id = execution.athlete_id
    WHERE execution.tenant_id = OLD.tenant_id
      AND athlete_test.id = OLD.test_id
      AND execution.status = 'ARTIFACTS_STAGED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM restore_privacy_replay_authorizations replay
    INNER JOIN tests athlete_test
      ON athlete_test.id = OLD.test_id
      AND athlete_test.tenant_id = OLD.tenant_id
    WHERE replay.tenant_id = OLD.tenant_id
      AND replay.athlete_id = athlete_test.athlete_id
      AND replay.status = 'ACTIVE'
  ) THEN RAISE(ABORT, 'test plan snapshots are immutable outside staged anonymization or restore privacy replay') END;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `diagnostic_result_snapshots_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `diagnostic_result_snapshots_immutable_delete`
BEFORE DELETE ON `diagnostic_result_snapshots`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM athlete_anonymization_executions execution
    INNER JOIN tests athlete_test
      ON athlete_test.tenant_id = execution.tenant_id
      AND athlete_test.athlete_id = execution.athlete_id
    WHERE execution.tenant_id = OLD.tenant_id
      AND athlete_test.id = OLD.test_id
      AND execution.status = 'ARTIFACTS_STAGED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM restore_privacy_replay_authorizations replay
    INNER JOIN tests athlete_test
      ON athlete_test.id = OLD.test_id
      AND athlete_test.tenant_id = OLD.tenant_id
    WHERE replay.tenant_id = OLD.tenant_id
      AND replay.athlete_id = athlete_test.athlete_id
      AND replay.status = 'ACTIVE'
  ) THEN RAISE(ABORT, 'diagnostic result snapshots are immutable outside staged anonymization or restore privacy replay') END;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `test_safety_checklists_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `test_safety_checklists_immutable_delete`
BEFORE DELETE ON `test_safety_checklist_confirmations`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM athlete_anonymization_executions execution
    INNER JOIN tests athlete_test
      ON athlete_test.tenant_id = execution.tenant_id
      AND athlete_test.athlete_id = execution.athlete_id
    WHERE execution.tenant_id = OLD.tenant_id
      AND athlete_test.id = OLD.test_id
      AND execution.status = 'ARTIFACTS_STAGED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM restore_privacy_replay_authorizations replay
    INNER JOIN tests athlete_test
      ON athlete_test.id = OLD.test_id
      AND athlete_test.tenant_id = OLD.tenant_id
    WHERE replay.tenant_id = OLD.tenant_id
      AND replay.athlete_id = athlete_test.athlete_id
      AND replay.status = 'ACTIVE'
  ) THEN RAISE(ABORT, 'test safety checklist confirmations are immutable outside staged anonymization or restore privacy replay') END;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `test_termination_events_immutable_delete`;
--> statement-breakpoint
CREATE TRIGGER `test_termination_events_immutable_delete`
BEFORE DELETE ON `test_termination_events`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM athlete_anonymization_executions execution
    INNER JOIN tests athlete_test
      ON athlete_test.tenant_id = execution.tenant_id
      AND athlete_test.athlete_id = execution.athlete_id
    WHERE execution.tenant_id = OLD.tenant_id
      AND athlete_test.id = OLD.test_id
      AND execution.status = 'ARTIFACTS_STAGED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM restore_privacy_replay_authorizations replay
    INNER JOIN tests athlete_test
      ON athlete_test.id = OLD.test_id
      AND athlete_test.tenant_id = OLD.tenant_id
    WHERE replay.tenant_id = OLD.tenant_id
      AND replay.athlete_id = athlete_test.athlete_id
      AND replay.status = 'ACTIVE'
  ) THEN RAISE(ABORT, 'test termination events are immutable outside staged anonymization or restore privacy replay') END;
END;
