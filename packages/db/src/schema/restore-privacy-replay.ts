import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { tenantId, timestamps } from './common';

export const restorePrivacyReplayAuthorizations = sqliteTable('restore_privacy_replay_authorizations', {
  executionId: text('execution_id').primaryKey(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull(),
  approvalId: text('approval_id').notNull(),
  deletionRequestId: text('deletion_request_id').notNull(),
  executionVersion: integer('execution_version').notNull(),
  policyVersion: text('policy_version').notNull(),
  scopeFingerprint: text('scope_fingerprint').notNull(),
  capabilityFingerprint: text('capability_fingerprint').notNull(),
  dbCommittedAt: text('db_committed_at').notNull(),
  status: text('status', { enum: ['ACTIVE', 'APPLIED'] }).notNull(),
  appliedAt: text('applied_at'),
  ...timestamps,
}, (t) => [
  index('restore_privacy_replay_authorizations_subject_idx').on(t.tenantId, t.athleteId, t.status),
]);
