CREATE TABLE `test_termination_events` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `test_id` text NOT NULL,
  `reason` text NOT NULL,
  `notes` text,
  `ended_by_user_id` text NOT NULL,
  `ended_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_termination_event_test_uq` ON `test_termination_events` (`tenant_id`,`test_id`);
--> statement-breakpoint
CREATE TRIGGER `test_termination_events_immutable_update`
BEFORE UPDATE ON `test_termination_events`
BEGIN
  SELECT RAISE(ABORT, 'test termination events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `test_termination_events_immutable_delete`
BEFORE DELETE ON `test_termination_events`
BEGIN
  SELECT RAISE(ABORT, 'test termination events are immutable');
END;
