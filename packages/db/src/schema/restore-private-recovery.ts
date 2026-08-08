import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tenantId } from './common';

export const restorePrivateRecoveryNormalizations = sqliteTable('restore_private_recovery_normalizations', {
  executionId: text('execution_id').primaryKey(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull(),
  backupCutoff: text('backup_cutoff').notNull(),
  planFingerprint: text('plan_fingerprint').notNull(),
  actionsFingerprint: text('actions_fingerprint').notNull(),
  intentSignature: text('intent_signature').notNull(),
  recoveryStartedAt: text('recovery_started_at').notNull(),
  snapshotStatus: text('snapshot_status', { enum: ['PREPARING', 'ARTIFACTS_STAGED'] }).notNull(),
  action: text('action', { enum: ['PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE'] }).notNull(),
  effectBasis: text('effect_basis', { enum: ['POST_BACKUP_COMMITTED'] }).notNull(),
  sourceDbCommittedAt: text('source_db_committed_at').notNull(),
  normalizedAt: text('normalized_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  index('restore_private_recovery_normalizations_subject_idx').on(t.tenantId, t.athleteId),
]);

export type RestorePrivateRecoveryNormalizationRow = typeof restorePrivateRecoveryNormalizations.$inferSelect;
