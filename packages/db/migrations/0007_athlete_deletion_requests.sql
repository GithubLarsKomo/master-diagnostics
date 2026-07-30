CREATE TABLE `athlete_deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`decision_reason` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_deletion_request_version_uq` ON `athlete_deletion_requests` (`tenant_id`,`athlete_id`,`requested_at`);