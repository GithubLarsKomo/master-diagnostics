import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps } from './common';

export const syncOperations = sqliteTable('sync_operations', {
  id: id(), tenantId: tenantId(), operationId: text('operation_id').notNull(), testId: text('test_id').notNull(),
  entityId: text('entity_id').notNull(), expectedVersion: integer('expected_version').notNull(),
  occurredAt: text('occurred_at').notNull(),
  operationType: text('operation_type').notNull(), schemaVersion: text('schema_version').notNull(), payloadJson: text('payload_json').notNull(),
  status: text('status', { enum: ['APPLIED','CONFLICT','REJECTED'] }).notNull(), resultJson: text('result_json'), appliedAt: text('applied_at'), ...timestamps,
}, (t) => [uniqueIndex('sync_operation_uq').on(t.operationId)]);

export const auditEvents = sqliteTable('audit_events', {
  id: id(), tenantId: tenantId(), occurredAt: text('occurred_at').notNull(), actorUserId: text('actor_user_id'), actorRole: text('actor_role'),
  action: text('action').notNull(), entityType: text('entity_type').notNull(), entityId: text('entity_id'), source: text('source').notNull(),
  reason: text('reason'), beforeJson: text('before_json'), afterJson: text('after_json'), correlationId: text('correlation_id').notNull(), ...timestamps,
});

export const notifications = sqliteTable('notifications', {
  id: id(), tenantId: tenantId(), recipientUserId: text('recipient_user_id').notNull(), type: text('type').notNull(), payloadJson: text('payload_json').notNull(),
  readAt: text('read_at'), ...timestamps,
});

export const backupRuns = sqliteTable('backup_runs', {
  id: id(), tenantId: tenantId(), status: text('status', { enum: ['RUNNING','SUCCEEDED','FAILED'] }).notNull(), targetType: text('target_type').notNull(),
  startedAt: text('started_at').notNull(), completedAt: text('completed_at'), checksum: text('checksum'), errorCode: text('error_code'), ...timestamps,
});

export const tenantExportPackages = sqliteTable('tenant_export_packages', {
  id: id(),
  tenantId: tenantId(),
  tokenHash: text('token_hash').notNull(),
  storageReference: text('storage_reference').notNull(),
  packageSha256: text('package_sha256').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  downloadedAt: text('downloaded_at'),
  ...timestamps,
}, (t) => [
  uniqueIndex('tenant_export_package_token_hash_uq').on(t.tokenHash),
  uniqueIndex('tenant_export_package_storage_reference_uq').on(t.storageReference),
]);
