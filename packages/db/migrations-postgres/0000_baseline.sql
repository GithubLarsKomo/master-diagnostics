CREATE TABLE "tenant_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"deployment_mode" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"locale" text DEFAULT 'de' NOT NULL,
	"retention_years" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"preferred_locale" text DEFAULT 'de' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_anonymization_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"deletion_request_id" text NOT NULL,
	"approval_version" integer NOT NULL,
	"policy_version" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"capability_fingerprint" text NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_anonymization_execution_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"kind" text NOT NULL,
	"storage_reference" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_anonymization_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"execution_version" integer NOT NULL,
	"status" text NOT NULL,
	"prepared_by_user_id" text NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"artifacts_staged_at" timestamp with time zone,
	"db_committed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_data_subject_delivery_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"approval_version" integer NOT NULL,
	"source_schema_version" text NOT NULL,
	"delivery_policy_version" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"source_fingerprint" text NOT NULL,
	"decisions_fingerprint" text NOT NULL,
	"review_decisions_json" jsonb NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_guardians" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"full_name" text NOT NULL,
	"relationship" text NOT NULL,
	"email" text,
	"phone" text,
	"authority_confirmed_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athletes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"linked_user_id" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"birth_date" date NOT NULL,
	"reference_category" text NOT NULL,
	"height_cm" integer NOT NULL,
	"current_weight_kg_x100" integer NOT NULL,
	"primary_sport" text NOT NULL,
	"primary_discipline" text NOT NULL,
	"training_status" text NOT NULL,
	"consent_blocked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_athlete_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"coach_user_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"consent_type" text NOT NULL,
	"status" text NOT NULL,
	"granted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"document_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"template_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"warmup_seconds" integer DEFAULT 600 NOT NULL,
	"readiness_seconds" integer DEFAULT 120 NOT NULL,
	"stage_seconds" integer DEFAULT 240 NOT NULL,
	"pause_seconds" integer DEFAULT 60 NOT NULL,
	"sample_target_seconds" integer DEFAULT 30 NOT NULL,
	"recovery_seconds" integer DEFAULT 300 NOT NULL,
	"default_max_stages" integer DEFAULT 8 NOT NULL,
	"partial_inclusion_percent" integer DEFAULT 50 NOT NULL,
	"config_json" jsonb DEFAULT '{}' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"device_type" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zone_rule_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"power_rules_json" jsonb NOT NULL,
	"heart_rate_rules_json" jsonb NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_measurements" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"target_offset_seconds" integer DEFAULT 300 NOT NULL,
	"actual_offset_seconds" integer,
	"heart_rate" integer,
	"lactate_value_x100" integer,
	"lactate_qualifier" text,
	"measured_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rest_measurements" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"heart_rate" integer,
	"lactate_value_x100" integer,
	"lactate_qualifier" text,
	"measured_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plan_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"protocol_version_id" text NOT NULL,
	"athlete_snapshot_id" text NOT NULL,
	"expected_lt2_watts" integer NOT NULL,
	"start_watts" integer NOT NULL,
	"increment_watts" integer NOT NULL,
	"maximum_stages" integer NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_safety_checklist_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"checklist_version" text NOT NULL,
	"confirmations_json" jsonb NOT NULL,
	"confirmed_by_user_id" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"stage_number" integer NOT NULL,
	"target_watts" integer NOT NULL,
	"planned_seconds" integer NOT NULL,
	"actual_seconds" integer,
	"mean_watts" integer,
	"end_watts" integer,
	"mean_heart_rate" integer,
	"end_heart_rate" integer,
	"mean_cadence" integer,
	"end_cadence" integer,
	"distance_meters" integer,
	"lactate_value_x100" integer,
	"lactate_qualifier" text,
	"lactate_measured_at" timestamp with time zone,
	"rpe_x10" integer,
	"quality_status" text DEFAULT 'MISSING' NOT NULL,
	"data_source" text DEFAULT 'MANUAL' NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_termination_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"reason" text NOT NULL,
	"notes" text,
	"ended_by_user_id" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"device_type" text NOT NULL,
	"status" text NOT NULL,
	"conducting_trainer_user_id" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_result_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"schema_version" text NOT NULL,
	"canonicalization" text NOT NULL,
	"result_hash" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"lt1_json" jsonb NOT NULL,
	"lt2_json" jsonb NOT NULL,
	"rationale" text,
	"status" text NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurement_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field_name" text NOT NULL,
	"old_value_json" jsonb,
	"new_value_json" jsonb NOT NULL,
	"reason" text NOT NULL,
	"corrected_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"stage_id" text,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"message_key" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"interpretation_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"locale" text NOT NULL,
	"content_hash" text NOT NULL,
	"storage_reference" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threshold_results" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"threshold_run_id" text NOT NULL,
	"threshold_type" text NOT NULL,
	"watts_x100" integer,
	"lactate_x100" integer,
	"heart_rate_x100" integer,
	"valid" boolean NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threshold_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"test_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_json" jsonb NOT NULL,
	"coefficients_json" jsonb,
	"warnings_json" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zone_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"interpretation_id" text NOT NULL,
	"model_type" text NOT NULL,
	"power_zones_json" jsonb NOT NULL,
	"heart_rate_zones_json" jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_data_subject_delivery_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"package_version" integer NOT NULL,
	"manifest_fingerprint" text NOT NULL,
	"token_hash" text NOT NULL,
	"storage_reference" text NOT NULL,
	"package_sha256" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event_privacy_redactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"audit_event_id" text NOT NULL,
	"subject_athlete_id" text NOT NULL,
	"redaction_version" integer NOT NULL,
	"redact_actor_user_id" boolean NOT NULL,
	"redact_session_id" boolean NOT NULL,
	"redact_reason" boolean NOT NULL,
	"redact_before_json" boolean NOT NULL,
	"redact_after_json" boolean NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"maintenance_reference" text NOT NULL,
	"redacted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_user_id" text,
	"actor_role" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"source" text NOT NULL,
	"reason" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"correlation_id" text NOT NULL,
	"auth_provider" text,
	"session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"status" text NOT NULL,
	"target_type" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"checksum" text,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"test_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"expected_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"operation_type" text NOT NULL,
	"schema_version" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"result_json" jsonb,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_export_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"storage_reference" text NOT NULL,
	"package_sha256" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_privacy_replay_authorizations" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"deletion_request_id" text NOT NULL,
	"execution_version" integer NOT NULL,
	"policy_version" text NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"capability_fingerprint" text NOT NULL,
	"db_committed_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_private_recovery_normalizations" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"backup_cutoff" timestamp with time zone NOT NULL,
	"plan_fingerprint" text NOT NULL,
	"actions_fingerprint" text NOT NULL,
	"intent_signature" text NOT NULL,
	"recovery_started_at" timestamp with time zone NOT NULL,
	"snapshot_status" text NOT NULL,
	"action" text NOT NULL,
	"effect_basis" text NOT NULL,
	"source_db_committed_at" timestamp with time zone NOT NULL,
	"normalized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_approvals" ADD CONSTRAINT "athlete_anonymization_approvals_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_approvals" ADD CONSTRAINT "athlete_anonymization_approvals_deletion_request_id_athlete_deletion_requests_id_fk" FOREIGN KEY ("deletion_request_id") REFERENCES "public"."athlete_deletion_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_approvals" ADD CONSTRAINT "athlete_anonymization_approvals_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_execution_artifacts" ADD CONSTRAINT "athlete_anonymization_execution_artifacts_execution_id_athlete_anonymization_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."athlete_anonymization_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_executions" ADD CONSTRAINT "athlete_anonymization_executions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_executions" ADD CONSTRAINT "athlete_anonymization_executions_approval_id_athlete_anonymization_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."athlete_anonymization_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_anonymization_executions" ADD CONSTRAINT "athlete_anonymization_executions_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_data_subject_delivery_approvals" ADD CONSTRAINT "athlete_data_subject_delivery_approvals_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_data_subject_delivery_approvals" ADD CONSTRAINT "athlete_data_subject_delivery_approvals_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_deletion_requests" ADD CONSTRAINT "athlete_deletion_requests_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_guardians" ADD CONSTRAINT "athlete_guardians_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_snapshots" ADD CONSTRAINT "athlete_snapshots_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athletes" ADD CONSTRAINT "athletes_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_athlete_assignments" ADD CONSTRAINT "coach_athlete_assignments_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_athlete_assignments" ADD CONSTRAINT "coach_athlete_assignments_coach_user_id_users_id_fk" FOREIGN KEY ("coach_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_template_versions" ADD CONSTRAINT "protocol_template_versions_template_id_protocol_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."protocol_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_measurements" ADD CONSTRAINT "recovery_measurements_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rest_measurements" ADD CONSTRAINT "rest_measurements_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_locks" ADD CONSTRAINT "test_locks_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_snapshots" ADD CONSTRAINT "test_plan_snapshots_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_snapshots" ADD CONSTRAINT "test_plan_snapshots_protocol_version_id_protocol_template_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "public"."protocol_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_snapshots" ADD CONSTRAINT "test_plan_snapshots_athlete_snapshot_id_athlete_snapshots_id_fk" FOREIGN KEY ("athlete_snapshot_id") REFERENCES "public"."athlete_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_safety_checklist_confirmations" ADD CONSTRAINT "test_safety_checklist_confirmations_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_stages" ADD CONSTRAINT "test_stages_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_termination_events" ADD CONSTRAINT "test_termination_events_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_result_snapshots" ADD CONSTRAINT "diagnostic_result_snapshots_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_corrections" ADD CONSTRAINT "measurement_corrections_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_flags" ADD CONSTRAINT "quality_flags_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_flags" ADD CONSTRAINT "quality_flags_stage_id_test_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."test_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threshold_results" ADD CONSTRAINT "threshold_results_threshold_run_id_threshold_runs_id_fk" FOREIGN KEY ("threshold_run_id") REFERENCES "public"."threshold_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threshold_runs" ADD CONSTRAINT "threshold_runs_test_id_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_profiles" ADD CONSTRAINT "zone_profiles_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_tenant_user_role_uq" ON "tenant_memberships" USING btree ("tenant_id","user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_uq" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_provider_subject_uq" ON "user_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_anonymization_approval_scope_uq" ON "athlete_anonymization_approvals" USING btree ("tenant_id","athlete_id","scope_fingerprint","capability_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_anonymization_execution_artifact_uq" ON "athlete_anonymization_execution_artifacts" USING btree ("execution_id","kind","storage_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_anonymization_execution_approval_uq" ON "athlete_anonymization_executions" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_data_subject_delivery_approval_scope_uq" ON "athlete_data_subject_delivery_approvals" USING btree ("tenant_id","athlete_id","source_fingerprint","decisions_fingerprint","approved_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_deletion_request_version_uq" ON "athlete_deletion_requests" USING btree ("tenant_id","athlete_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_active_identity_uq" ON "athlete_guardians" USING btree ("tenant_id","athlete_id","full_name","authority_confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_tenant_linked_user_uq" ON "athletes" USING btree ("tenant_id","linked_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_active_uq" ON "coach_athlete_assignments" USING btree ("tenant_id","athlete_id","coach_user_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_template_version_uq" ON "protocol_template_versions" USING btree ("tenant_id","template_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_template_tenant_device_name_uq" ON "protocol_templates" USING btree ("tenant_id","device_type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_measurement_test_uq" ON "recovery_measurements" USING btree ("tenant_id","test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rest_measurement_test_uq" ON "rest_measurements" USING btree ("tenant_id","test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_lock_test_uq" ON "test_locks" USING btree ("tenant_id","test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_plan_snapshot_test_uq" ON "test_plan_snapshots" USING btree ("tenant_id","test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_safety_checklist_test_uq" ON "test_safety_checklist_confirmations" USING btree ("tenant_id","test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_stage_number_uq" ON "test_stages" USING btree ("tenant_id","test_id","stage_number");--> statement-breakpoint
CREATE UNIQUE INDEX "test_termination_event_test_uq" ON "test_termination_events" USING btree ("tenant_id","test_id");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnostic_result_snapshot_test_version_uq" ON "diagnostic_result_snapshots" USING btree ("tenant_id","test_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "interpretation_test_version_uq" ON "interpretations" USING btree ("tenant_id","test_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "report_version_test_locale_version_uq" ON "report_versions" USING btree ("tenant_id","test_id","locale","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_data_subject_delivery_package_token_hash_uq" ON "athlete_data_subject_delivery_packages" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_data_subject_delivery_package_storage_reference_uq" ON "athlete_data_subject_delivery_packages" USING btree ("storage_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_privacy_redaction_event_uq" ON "audit_event_privacy_redactions" USING btree ("audit_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_operation_uq" ON "sync_operations" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_export_package_token_hash_uq" ON "tenant_export_packages" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_export_package_storage_reference_uq" ON "tenant_export_packages" USING btree ("storage_reference");--> statement-breakpoint
CREATE INDEX "restore_privacy_replay_authorizations_subject_idx" ON "restore_privacy_replay_authorizations" USING btree ("tenant_id","athlete_id","status");--> statement-breakpoint
CREATE INDEX "restore_private_recovery_normalizations_subject_idx" ON "restore_private_recovery_normalizations" USING btree ("tenant_id","athlete_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_uq" ON "auth_session" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_email_uq" ON "auth_user" USING btree ("email");