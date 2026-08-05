import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps, version } from './common';
import { users } from './identity';

export const athletes = sqliteTable('athletes', {
  id: id(),
  tenantId: tenantId(),
  linkedUserId: text('linked_user_id').references(() => users.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  birthDate: text('birth_date').notNull(),
  referenceCategory: text('reference_category').notNull(),
  heightCm: integer('height_cm').notNull(),
  currentWeightKgX100: integer('current_weight_kg_x100').notNull(),
  primarySport: text('primary_sport').notNull(),
  primaryDiscipline: text('primary_discipline').notNull(),
  trainingStatus: text('training_status').notNull(),
  consentBlockedAt: text('consent_blocked_at'),
  deletedAt: text('deleted_at'),
  ...timestamps,
}, (t) => [uniqueIndex('athlete_tenant_linked_user_uq').on(t.tenantId, t.linkedUserId)]);

export const athleteSnapshots = sqliteTable('athlete_snapshots', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  snapshotJson: text('snapshot_json').notNull(), version: version(), ...timestamps,
});

export const coachAthleteAssignments = sqliteTable('coach_athlete_assignments', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  coachUserId: text('coach_user_id').notNull().references(() => users.id),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  validFrom: text('valid_from').notNull(), validUntil: text('valid_until'), ...timestamps,
}, (t) => [uniqueIndex('assignment_active_uq').on(t.tenantId, t.athleteId, t.coachUserId, t.validFrom)]);

export const consents = sqliteTable('consents', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  consentType: text('consent_type').notNull(), status: text('status', { enum: ['GRANTED','WITHDRAWN','EXPIRED'] }).notNull(),
  grantedAt: text('granted_at'), withdrawnAt: text('withdrawn_at'), documentVersion: text('document_version').notNull(), ...timestamps,
});

export const athleteGuardians = sqliteTable('athlete_guardians', {
  id: id(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id),
  fullName: text('full_name').notNull(),
  relationship: text('relationship').notNull(),
  email: text('email'),
  phone: text('phone'),
  authorityConfirmedAt: text('authority_confirmed_at').notNull(),
  validUntil: text('valid_until'),
  revokedAt: text('revoked_at'),
  ...timestamps,
}, (t) => [uniqueIndex('guardian_active_identity_uq').on(t.tenantId, t.athleteId, t.fullName, t.authorityConfirmedAt)]);

export const athleteDeletionRequests = sqliteTable('athlete_deletion_requests', {
  id: id(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id),
  status: text('status', { enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED'] }).notNull(),
  reason: text('reason').notNull(),
  requestedAt: text('requested_at').notNull(),
  decidedAt: text('decided_at'),
  decisionReason: text('decision_reason'),
  completedAt: text('completed_at'),
  ...timestamps,
}, (t) => [uniqueIndex('athlete_deletion_request_version_uq').on(t.tenantId, t.athleteId, t.requestedAt)]);

export const athleteAnonymizationApprovals = sqliteTable('athlete_anonymization_approvals', {
  id: id(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id),
  deletionRequestId: text('deletion_request_id').notNull().references(() => athleteDeletionRequests.id),
  approvalVersion: integer('approval_version').notNull(),
  policyVersion: text('policy_version').notNull(),
  assessedAt: text('assessed_at').notNull(),
  scopeFingerprint: text('scope_fingerprint').notNull(),
  capabilityFingerprint: text('capability_fingerprint').notNull(),
  approvedByUserId: text('approved_by_user_id').notNull().references(() => users.id),
  approvedAt: text('approved_at').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('athlete_anonymization_approval_scope_uq')
    .on(t.tenantId, t.athleteId, t.scopeFingerprint, t.capabilityFingerprint),
]);

export const athleteAnonymizationExecutions = sqliteTable('athlete_anonymization_executions', {
  id: id(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id),
  approvalId: text('approval_id').notNull().references(() => athleteAnonymizationApprovals.id),
  executionVersion: integer('execution_version').notNull(),
  status: text('status', { enum: [
    'PREPARING',
    'ARTIFACTS_STAGED',
    'DB_COMMITTED',
    'COMPLETED',
    'ABORTED',
  ] }).notNull(),
  preparedByUserId: text('prepared_by_user_id').notNull().references(() => users.id),
  preparedAt: text('prepared_at').notNull(),
  artifactsStagedAt: text('artifacts_staged_at'),
  dbCommittedAt: text('db_committed_at'),
  completedAt: text('completed_at'),
  abortedAt: text('aborted_at'),
  ...timestamps,
}, (t) => [
  uniqueIndex('athlete_anonymization_execution_approval_uq').on(t.approvalId),
]);

export const athleteAnonymizationExecutionArtifacts = sqliteTable('athlete_anonymization_execution_artifacts', {
  id: id(),
  tenantId: tenantId(),
  executionId: text('execution_id').notNull().references(() => athleteAnonymizationExecutions.id),
  kind: text('kind', { enum: ['REPORT', 'TENANT_EXPORT'] }).notNull(),
  storageReference: text('storage_reference').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('athlete_anonymization_execution_artifact_uq')
    .on(t.executionId, t.kind, t.storageReference),
]);

export const athleteDataSubjectDeliveryApprovals = sqliteTable('athlete_data_subject_delivery_approvals', {
  id: id(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id),
  approvalVersion: integer('approval_version').notNull(),
  sourceSchemaVersion: text('source_schema_version').notNull(),
  deliveryPolicyVersion: text('delivery_policy_version').notNull(),
  assessedAt: text('assessed_at').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  decisionsFingerprint: text('decisions_fingerprint').notNull(),
  reviewDecisionsJson: text('review_decisions_json').notNull(),
  approvedByUserId: text('approved_by_user_id').notNull().references(() => users.id),
  approvedAt: text('approved_at').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('athlete_data_subject_delivery_approval_scope_uq')
    .on(t.tenantId, t.athleteId, t.sourceFingerprint, t.decisionsFingerprint, t.approvedByUserId),
]);
