CREATE TABLE `athlete_guardians` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`full_name` text NOT NULL,
	`relationship` text NOT NULL,
	`email` text,
	`phone` text,
	`authority_confirmed_at` text NOT NULL,
	`valid_until` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guardian_active_identity_uq` ON `athlete_guardians` (`tenant_id`,`athlete_id`,`full_name`,`authority_confirmed_at`);
