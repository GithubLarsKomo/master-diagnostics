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
  ) THEN RAISE(ABORT, 'test plan snapshots are immutable outside staged anonymization execution') END;
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
  ) THEN RAISE(ABORT, 'diagnostic result snapshots are immutable outside staged anonymization execution') END;
END;
