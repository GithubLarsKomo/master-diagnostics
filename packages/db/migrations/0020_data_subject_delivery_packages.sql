CREATE TABLE `athlete_data_subject_delivery_packages` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `athlete_id` text NOT NULL,
  `approval_id` text NOT NULL,
  `package_version` integer NOT NULL,
  `manifest_fingerprint` text NOT NULL,
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
CREATE UNIQUE INDEX `athlete_data_subject_delivery_package_token_hash_uq`
ON `athlete_data_subject_delivery_packages` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_data_subject_delivery_package_storage_reference_uq`
ON `athlete_data_subject_delivery_packages` (`storage_reference`);
--> statement-breakpoint
CREATE TRIGGER athlete_data_subject_delivery_packages_validate_insert
BEFORE INSERT ON athlete_data_subject_delivery_packages
BEGIN
  SELECT CASE WHEN NEW.package_version <> 1
    THEN RAISE(ABORT, 'unsupported data subject delivery package version') END;
  SELECT CASE WHEN NEW.manifest_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid data subject delivery manifest fingerprint') END;
  SELECT CASE WHEN NEW.token_hash NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid data subject delivery token hash') END;
  SELECT CASE WHEN NEW.package_sha256 NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid data subject delivery package hash') END;
  SELECT CASE WHEN NEW.expires_at <= NEW.created_at
    THEN RAISE(ABORT, 'data subject delivery package expiry must be after creation') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM athlete_data_subject_delivery_approvals approval
    WHERE approval.id = NEW.approval_id
      AND approval.tenant_id = NEW.tenant_id
      AND approval.athlete_id = NEW.athlete_id
  ) THEN RAISE(ABORT, 'data subject delivery approval tenant athlete boundary required') END;
END;
--> statement-breakpoint
CREATE TRIGGER athlete_data_subject_delivery_packages_protect_update
BEFORE UPDATE ON athlete_data_subject_delivery_packages
BEGIN
  SELECT CASE WHEN OLD.id IS NOT NEW.id
    OR OLD.tenant_id IS NOT NEW.tenant_id
    OR OLD.athlete_id IS NOT NEW.athlete_id
    OR OLD.approval_id IS NOT NEW.approval_id
    OR OLD.package_version IS NOT NEW.package_version
    OR OLD.manifest_fingerprint IS NOT NEW.manifest_fingerprint
    OR OLD.token_hash IS NOT NEW.token_hash
    OR OLD.storage_reference IS NOT NEW.storage_reference
    OR OLD.package_sha256 IS NOT NEW.package_sha256
    OR OLD.created_by_user_id IS NOT NEW.created_by_user_id
    OR OLD.expires_at IS NOT NEW.expires_at
    OR OLD.created_at IS NOT NEW.created_at
    THEN RAISE(ABORT, 'data subject delivery package metadata is immutable') END;
  SELECT CASE WHEN OLD.downloaded_at IS NOT NULL OR NEW.downloaded_at IS NULL
    THEN RAISE(ABORT, 'data subject delivery package may only be consumed once') END;
  SELECT CASE WHEN NEW.updated_at <> NEW.downloaded_at
    THEN RAISE(ABORT, 'data subject delivery package update time must equal download time') END;
END;
