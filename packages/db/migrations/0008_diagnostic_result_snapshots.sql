CREATE TABLE `diagnostic_result_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `test_id` text NOT NULL,
  `version_number` integer NOT NULL,
  `schema_version` text NOT NULL,
  `canonicalization` text NOT NULL,
  `result_hash` text NOT NULL,
  `result_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_result_snapshot_test_version_uq` ON `diagnostic_result_snapshots` (`tenant_id`,`test_id`,`version_number`);
--> statement-breakpoint
CREATE TRIGGER `diagnostic_result_snapshots_immutable_update`
BEFORE UPDATE ON `diagnostic_result_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'diagnostic result snapshots are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `diagnostic_result_snapshots_immutable_delete`
BEFORE DELETE ON `diagnostic_result_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'diagnostic result snapshots are immutable');
END;
