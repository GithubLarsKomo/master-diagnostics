CREATE TABLE `diagnostic_result_records` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `test_id` text NOT NULL,
  `recorded_at` text NOT NULL,
  `snapshot_schema` text NOT NULL,
  `canonicalization` text NOT NULL,
  `result_hash` text NOT NULL,
  `snapshot_json` text NOT NULL,
  FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_result_record_tenant_id_uq` ON `diagnostic_result_records` (`tenant_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_result_record_tenant_test_hash_uq` ON `diagnostic_result_records` (`tenant_id`,`test_id`,`result_hash`);
