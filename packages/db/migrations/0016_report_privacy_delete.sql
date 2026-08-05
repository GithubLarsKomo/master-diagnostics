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
  ) THEN RAISE(ABORT, 'report versions are immutable outside staged anonymization execution') END;
END;
