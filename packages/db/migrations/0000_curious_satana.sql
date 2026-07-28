CREATE TABLE `tenant_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_tenant_user_role_uq` ON `tenant_memberships` (`tenant_id`,`user_id`,`role`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`deployment_mode` text NOT NULL,
	`timezone` text DEFAULT 'Europe/Berlin' NOT NULL,
	`locale` text DEFAULT 'de' NOT NULL,
	`retention_years` integer DEFAULT 10 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_uq` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_provider_subject_uq` ON `user_identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`preferred_locale` text DEFAULT 'de' NOT NULL,
	`disabled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `athlete_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `athletes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`linked_user_id` text,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`birth_date` text NOT NULL,
	`reference_category` text NOT NULL,
	`height_cm` integer NOT NULL,
	`current_weight_kg_x100` integer NOT NULL,
	`primary_sport` text NOT NULL,
	`primary_discipline` text NOT NULL,
	`training_status` text NOT NULL,
	`consent_blocked_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`linked_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_tenant_linked_user_uq` ON `athletes` (`tenant_id`,`linked_user_id`);--> statement-breakpoint
CREATE TABLE `coach_athlete_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`coach_user_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`valid_from` text NOT NULL,
	`valid_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coach_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_active_uq` ON `coach_athlete_assignments` (`tenant_id`,`athlete_id`,`coach_user_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`consent_type` text NOT NULL,
	`status` text NOT NULL,
	`granted_at` text,
	`withdrawn_at` text,
	`document_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `protocol_template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`template_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`warmup_seconds` integer DEFAULT 600 NOT NULL,
	`readiness_seconds` integer DEFAULT 120 NOT NULL,
	`stage_seconds` integer DEFAULT 240 NOT NULL,
	`pause_seconds` integer DEFAULT 60 NOT NULL,
	`sample_target_seconds` integer DEFAULT 30 NOT NULL,
	`recovery_seconds` integer DEFAULT 300 NOT NULL,
	`default_max_stages` integer DEFAULT 8 NOT NULL,
	`partial_inclusion_percent` integer DEFAULT 50 NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `protocol_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_template_version_uq` ON `protocol_template_versions` (`tenant_id`,`template_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `protocol_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`device_type` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `zone_rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`power_rules_json` text NOT NULL,
	`heart_rate_rules_json` text NOT NULL,
	`active_from` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recovery_measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`target_offset_seconds` integer DEFAULT 300 NOT NULL,
	`actual_offset_seconds` integer,
	`heart_rate` integer,
	`lactate_value_x100` integer,
	`lactate_qualifier` text,
	`measured_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rest_measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`heart_rate` integer,
	`lactate_value_x100` integer,
	`lactate_qualifier` text,
	`measured_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `test_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_lock_test_uq` ON `test_locks` (`tenant_id`,`test_id`);--> statement-breakpoint
CREATE TABLE `test_plan_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`protocol_version_id` text NOT NULL,
	`athlete_snapshot_id` text NOT NULL,
	`expected_lt2_watts` integer NOT NULL,
	`start_watts` integer NOT NULL,
	`increment_watts` integer NOT NULL,
	`maximum_stages` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`protocol_version_id`) REFERENCES `protocol_template_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`athlete_snapshot_id`) REFERENCES `athlete_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_plan_snapshot_test_uq` ON `test_plan_snapshots` (`tenant_id`,`test_id`);--> statement-breakpoint
CREATE TABLE `test_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`stage_number` integer NOT NULL,
	`target_watts` integer NOT NULL,
	`planned_seconds` integer NOT NULL,
	`actual_seconds` integer,
	`mean_watts` integer,
	`end_watts` integer,
	`mean_heart_rate` integer,
	`end_heart_rate` integer,
	`mean_cadence` integer,
	`end_cadence` integer,
	`distance_meters` integer,
	`lactate_value_x100` integer,
	`lactate_qualifier` text,
	`rpe_x10` integer,
	`quality_status` text DEFAULT 'MISSING' NOT NULL,
	`data_source` text DEFAULT 'MANUAL' NOT NULL,
	`notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_stage_number_uq` ON `test_stages` (`tenant_id`,`test_id`,`stage_number`);--> statement-breakpoint
CREATE TABLE `tests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`device_type` text NOT NULL,
	`status` text NOT NULL,
	`conducting_trainer_user_id` text NOT NULL,
	`scheduled_at` text,
	`started_at` text,
	`ended_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`released_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `interpretations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`lt1_json` text NOT NULL,
	`lt2_json` text NOT NULL,
	`rationale` text,
	`status` text NOT NULL,
	`released_at` text,
	`released_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interpretation_test_version_uq` ON `interpretations` (`tenant_id`,`test_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `measurement_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field_name` text NOT NULL,
	`old_value_json` text,
	`new_value_json` text NOT NULL,
	`reason` text NOT NULL,
	`corrected_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quality_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`stage_id` text,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`message_key` text NOT NULL,
	`acknowledged_at` text,
	`acknowledged_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_id`) REFERENCES `test_stages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `report_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`interpretation_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`locale` text NOT NULL,
	`content_hash` text NOT NULL,
	`storage_reference` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`interpretation_id`) REFERENCES `interpretations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `threshold_results` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`threshold_run_id` text NOT NULL,
	`threshold_type` text NOT NULL,
	`watts_x100` integer,
	`lactate_x100` integer,
	`heart_rate_x100` integer,
	`valid` integer NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`threshold_run_id`) REFERENCES `threshold_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `threshold_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`test_id` text NOT NULL,
	`algorithm` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_json` text NOT NULL,
	`coefficients_json` text,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `zone_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`interpretation_id` text NOT NULL,
	`model_type` text NOT NULL,
	`power_zones_json` text NOT NULL,
	`heart_rate_zones_json` text NOT NULL,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`interpretation_id`) REFERENCES `interpretations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_user_id` text,
	`actor_role` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`source` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`status` text NOT NULL,
	`target_type` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`checksum` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`read_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`test_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`schema_version` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`applied_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_operation_uq` ON `sync_operations` (`tenant_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_uq` ON `auth_session` (`token`);--> statement-breakpoint
CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_user_email_uq` ON `auth_user` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
