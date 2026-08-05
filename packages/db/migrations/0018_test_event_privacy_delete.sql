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
  ) THEN RAISE(ABORT, 'test safety checklist confirmations are immutable outside staged anonymization execution') END;
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
  ) THEN RAISE(ABORT, 'test termination events are immutable outside staged anonymization execution') END;
END;
