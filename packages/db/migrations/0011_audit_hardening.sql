ALTER TABLE `audit_events` ADD `auth_provider` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `session_id` text;
--> statement-breakpoint
CREATE TRIGGER `audit_events_immutable_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_immutable_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;
