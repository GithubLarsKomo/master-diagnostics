CREATE TABLE `athlete_anonymization_approvals` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `athlete_id` text NOT NULL,
  `deletion_request_id` text NOT NULL,
  `approval_version` integer NOT NULL,
  `policy_version` text NOT NULL,
  `assessed_at` text NOT NULL,
  `scope_fingerprint` text NOT NULL,
  `capability_fingerprint` text NOT NULL,
  `approved_by_user_id` text NOT NULL,
  `approved_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`deletion_request_id`) REFERENCES `athlete_deletion_requests`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_anonymization_approval_scope_uq` ON `athlete_anonymization_approvals` (`tenant_id`,`athlete_id`,`scope_fingerprint`,`capability_fingerprint`);
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_approvals_validate_insert
BEFORE INSERT ON athlete_anonymization_approvals
BEGIN
  SELECT CASE WHEN NEW.approval_version <> 1
    THEN RAISE(ABORT, 'unsupported anonymization approval version') END;
  SELECT CASE WHEN NEW.scope_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid anonymization scope fingerprint') END;
  SELECT CASE WHEN NEW.capability_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid anonymization capability fingerprint') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM athlete_deletion_requests request
    WHERE request.id = NEW.deletion_request_id
      AND request.tenant_id = NEW.tenant_id
      AND request.athlete_id = NEW.athlete_id
      AND request.status = 'COMPLETED'
  ) THEN RAISE(ABORT, 'completed deletion request required for anonymization approval') END;
END;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_approvals_immutable_update
BEFORE UPDATE ON athlete_anonymization_approvals
BEGIN
  SELECT RAISE(ABORT, 'anonymization approvals are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER athlete_anonymization_approvals_immutable_delete
BEFORE DELETE ON athlete_anonymization_approvals
BEGIN
  SELECT RAISE(ABORT, 'anonymization approvals are immutable');
END;
