CREATE TABLE `audit_event_privacy_redactions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `audit_event_id` text NOT NULL,
  `subject_athlete_id` text NOT NULL,
  `redaction_version` integer NOT NULL,
  `redact_actor_user_id` integer NOT NULL,
  `redact_session_id` integer NOT NULL,
  `redact_reason` integer NOT NULL,
  `redact_before_json` integer NOT NULL,
  `redact_after_json` integer NOT NULL,
  `requested_by_user_id` text NOT NULL,
  `maintenance_reference` text NOT NULL,
  `redacted_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_event_privacy_redaction_event_uq` ON `audit_event_privacy_redactions` (`audit_event_id`);
--> statement-breakpoint
CREATE INDEX `audit_event_privacy_redaction_subject_idx` ON `audit_event_privacy_redactions` (`tenant_id`, `subject_athlete_id`);
--> statement-breakpoint
CREATE TRIGGER audit_event_privacy_redactions_validate_insert
BEFORE INSERT ON audit_event_privacy_redactions
BEGIN
  SELECT CASE WHEN NEW.redaction_version <> 1
    THEN RAISE(ABORT, 'unsupported audit privacy redaction version') END;
  SELECT CASE WHEN length(trim(NEW.maintenance_reference)) < 5
    THEN RAISE(ABORT, 'audit privacy redaction reference is required') END;
  SELECT CASE WHEN (
    NEW.redact_actor_user_id = 0
    AND NEW.redact_session_id = 0
    AND NEW.redact_reason = 0
    AND NEW.redact_before_json = 0
    AND NEW.redact_after_json = 0
  ) THEN RAISE(ABORT, 'audit privacy redaction must redact at least one field') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.id = NEW.audit_event_id
      AND event.tenant_id = NEW.tenant_id
  ) THEN RAISE(ABORT, 'audit privacy redaction event not found') END;
END;
--> statement-breakpoint
CREATE TRIGGER audit_event_privacy_redactions_immutable_update
BEFORE UPDATE ON audit_event_privacy_redactions
BEGIN
  SELECT RAISE(ABORT, 'audit privacy redactions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER audit_event_privacy_redactions_immutable_delete
BEFORE DELETE ON audit_event_privacy_redactions
BEGIN
  SELECT RAISE(ABORT, 'audit privacy redactions are immutable');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_immutable_update;
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM audit_event_privacy_redactions redaction
    WHERE redaction.audit_event_id = OLD.id
      AND redaction.tenant_id = OLD.tenant_id
      AND redaction.redaction_version = 1
      AND NEW.id IS OLD.id
      AND NEW.tenant_id IS OLD.tenant_id
      AND NEW.occurred_at IS OLD.occurred_at
      AND NEW.actor_role IS OLD.actor_role
      AND NEW.action IS OLD.action
      AND NEW.entity_type IS OLD.entity_type
      AND NEW.entity_id IS OLD.entity_id
      AND NEW.source IS OLD.source
      AND NEW.correlation_id IS OLD.correlation_id
      AND NEW.auth_provider IS OLD.auth_provider
      AND NEW.created_at IS OLD.created_at
      AND NEW.updated_at IS OLD.updated_at
      AND NEW.actor_user_id IS (
        CASE WHEN redaction.redact_actor_user_id = 1 THEN NULL ELSE OLD.actor_user_id END
      )
      AND NEW.session_id IS (
        CASE WHEN redaction.redact_session_id = 1 THEN NULL ELSE OLD.session_id END
      )
      AND NEW.reason IS (
        CASE
          WHEN redaction.redact_reason = 1 AND OLD.reason IS NOT NULL THEN '[REDACTED]'
          ELSE OLD.reason
        END
      )
      AND NEW.before_json IS (
        CASE
          WHEN redaction.redact_before_json = 1 AND OLD.before_json IS NOT NULL
            THEN '{"auditSchemaVersion":3,"privacyRedacted":true}'
          ELSE OLD.before_json
        END
      )
      AND NEW.after_json IS (
        CASE
          WHEN redaction.redact_after_json = 1 AND OLD.after_json IS NOT NULL
            THEN '{"auditSchemaVersion":3,"privacyRedacted":true}'
          ELSE OLD.after_json
        END
      )
  ) THEN RAISE(ABORT, 'audit events are immutable') END;
END;
