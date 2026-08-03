CREATE TABLE `tenant_export_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`storage_reference` text NOT NULL,
	`package_sha256` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`downloaded_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_export_package_token_hash_uq` ON `tenant_export_packages` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_export_package_storage_reference_uq` ON `tenant_export_packages` (`storage_reference`);
--> statement-breakpoint
CREATE INDEX `tenant_export_package_expiry_idx` ON `tenant_export_packages` (`expires_at`);
