CREATE TABLE `test_safety_checklist_confirmations` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `test_id` text NOT NULL,
  `checklist_version` text NOT NULL,
  `confirmations_json` text NOT NULL,
  `confirmed_by_user_id` text NOT NULL,
  `confirmed_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_safety_checklist_test_uq` ON `test_safety_checklist_confirmations` (`tenant_id`,`test_id`);
--> statement-breakpoint
CREATE TRIGGER `test_safety_checklists_immutable_update`
BEFORE UPDATE ON `test_safety_checklist_confirmations`
BEGIN
  SELECT RAISE(ABORT, 'test safety checklist confirmations are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `test_safety_checklists_immutable_delete`
BEFORE DELETE ON `test_safety_checklist_confirmations`
BEGIN
  SELECT RAISE(ABORT, 'test safety checklist confirmations are immutable');
END;
