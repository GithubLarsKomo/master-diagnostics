DROP TRIGGER athlete_anonymization_execution_artifacts_validate_insert;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_execution_artifacts_validate_insert
BEFORE INSERT ON athlete_anonymization_execution_artifacts
BEGIN
  SELECT CASE WHEN NEW.kind NOT IN ('REPORT', 'TENANT_EXPORT', 'DATA_SUBJECT_EXPORT')
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
