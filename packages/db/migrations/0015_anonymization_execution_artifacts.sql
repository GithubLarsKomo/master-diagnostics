CREATE TABLE `athlete_anonymization_execution_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `execution_id` text NOT NULL,
  `kind` text NOT NULL,
  `storage_reference` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `athlete_anonymization_executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_anonymization_execution_artifact_uq` ON `athlete_anonymization_execution_artifacts` (`execution_id`,`kind`,`storage_reference`);
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_execution_artifacts_validate_insert
BEFORE INSERT ON athlete_anonymization_execution_artifacts
BEGIN
  SELECT CASE WHEN NEW.kind NOT IN ('REPORT', 'TENANT_EXPORT')
    THEN RAISE(ABORT, 'unsupported anonymization artifact kind') END;
  SELECT CASE WHEN length(trim(NEW.storage_reference)) = 0
    THEN RAISE(ABORT, 'anonymization artifact reference is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM athlete_anonymization_executions execution
    WHERE execution.id = NEW.execution_id
      AND execution.tenant_id = NEW.tenant_id
      AND execution.status = 'PREPARING'
  ) THEN RAISE(ABORT, 'PREPARING anonymization execution required for artifact manifest') END;
END;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_execution_artifacts_immutable_update
BEFORE UPDATE ON athlete_anonymization_execution_artifacts
BEGIN
  SELECT RAISE(ABORT, 'anonymization execution artifact manifest is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_execution_artifacts_immutable_delete
BEFORE DELETE ON athlete_anonymization_execution_artifacts
BEGIN
  SELECT RAISE(ABORT, 'anonymization execution artifact manifest is immutable');
END;
