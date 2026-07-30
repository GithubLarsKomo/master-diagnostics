ALTER TABLE `test_stages` ADD `lactate_measured_at` text;
--> statement-breakpoint
ALTER TABLE `rest_measurements` ADD `version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `rest_measurement_test_uq` ON `rest_measurements` (`tenant_id`,`test_id`);
--> statement-breakpoint
ALTER TABLE `recovery_measurements` ADD `version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_measurement_test_uq` ON `recovery_measurements` (`tenant_id`,`test_id`);
--> statement-breakpoint
ALTER TABLE `sync_operations` ADD `entity_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sync_operations` ADD `expected_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sync_operations` ADD `occurred_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DROP INDEX `sync_operation_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_operation_uq` ON `sync_operations` (`operation_id`);
