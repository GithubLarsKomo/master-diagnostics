CREATE TABLE `athlete_data_subject_delivery_approvals` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `athlete_id` text NOT NULL,
  `approval_version` integer NOT NULL,
  `source_schema_version` text NOT NULL,
  `delivery_policy_version` text NOT NULL,
  `assessed_at` text NOT NULL,
  `source_fingerprint` text NOT NULL,
  `decisions_fingerprint` text NOT NULL,
  `review_decisions_json` text NOT NULL,
  `approved_by_user_id` text NOT NULL,
  `approved_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_data_subject_delivery_approval_scope_uq`
ON `athlete_data_subject_delivery_approvals` (`tenant_id`,`athlete_id`,`source_fingerprint`,`decisions_fingerprint`,`approved_by_user_id`);
--> statement-breakpoint
CREATE TRIGGER athlete_data_subject_delivery_approvals_validate_insert
BEFORE INSERT ON athlete_data_subject_delivery_approvals
BEGIN
  SELECT CASE WHEN NEW.approval_version <> 1
    THEN RAISE(ABORT, 'unsupported data subject delivery approval version') END;
  SELECT CASE WHEN NEW.source_schema_version <> 'masters-data-subject-export-v1'
    THEN RAISE(ABORT, 'unsupported data subject source schema version') END;
  SELECT CASE WHEN NEW.delivery_policy_version <> 'masters-data-subject-delivery-v1'
    THEN RAISE(ABORT, 'unsupported data subject delivery policy version') END;
  SELECT CASE WHEN NEW.source_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid data subject source fingerprint') END;
  SELECT CASE WHEN NEW.decisions_fingerprint NOT GLOB 'sha256:*'
    THEN RAISE(ABORT, 'invalid data subject review decisions fingerprint') END;
  SELECT CASE WHEN json_valid(NEW.review_decisions_json) <> 1
    THEN RAISE(ABORT, 'invalid data subject review decisions json') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM athletes athlete
    WHERE athlete.id = NEW.athlete_id
      AND athlete.tenant_id = NEW.tenant_id
  ) THEN RAISE(ABORT, 'athlete tenant boundary required for data subject delivery approval') END;
END;
--> statement-breakpoint
CREATE TRIGGER athlete_data_subject_delivery_approvals_immutable_update
BEFORE UPDATE ON athlete_data_subject_delivery_approvals
BEGIN
  SELECT RAISE(ABORT, 'data subject delivery approvals are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER athlete_data_subject_delivery_approvals_immutable_delete
BEFORE DELETE ON athlete_data_subject_delivery_approvals
BEGIN
  SELECT RAISE(ABORT, 'data subject delivery approvals are immutable');
END;
