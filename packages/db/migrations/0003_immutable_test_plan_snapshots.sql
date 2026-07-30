CREATE TRIGGER `test_plan_snapshots_immutable_update`
BEFORE UPDATE ON `test_plan_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'test plan snapshots are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `test_plan_snapshots_immutable_delete`
BEFORE DELETE ON `test_plan_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'test plan snapshots are immutable');
END;
