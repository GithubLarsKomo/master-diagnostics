import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps } from './common';
import { tests, testStages } from './tests';

export const qualityFlags = sqliteTable('quality_flags', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id), stageId: text('stage_id').references(() => testStages.id),
  code: text('code').notNull(), severity: text('severity', { enum: ['INFO','WARNING','CRITICAL'] }).notNull(), messageKey: text('message_key').notNull(),
  acknowledgedAt: text('acknowledged_at'), acknowledgedByUserId: text('acknowledged_by_user_id'), ...timestamps,
});

export const measurementCorrections = sqliteTable('measurement_corrections', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id), entityType: text('entity_type').notNull(), entityId: text('entity_id').notNull(),
  fieldName: text('field_name').notNull(), oldValueJson: text('old_value_json'), newValueJson: text('new_value_json').notNull(), reason: text('reason').notNull(), correctedByUserId: text('corrected_by_user_id').notNull(), ...timestamps,
});

export const thresholdRuns = sqliteTable('threshold_runs', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id), algorithm: text('algorithm').notNull(), algorithmVersion: text('algorithm_version').notNull(),
  inputHash: text('input_hash').notNull(), inputJson: text('input_json').notNull(), coefficientsJson: text('coefficients_json'), warningsJson: text('warnings_json').notNull().default('[]'), ...timestamps,
});

export const thresholdResults = sqliteTable('threshold_results', {
  id: id(), tenantId: tenantId(), thresholdRunId: text('threshold_run_id').notNull().references(() => thresholdRuns.id), thresholdType: text('threshold_type', { enum: ['LT1','LT2'] }).notNull(),
  wattsX100: integer('watts_x100'), lactateX100: integer('lactate_x100'), heartRateX100: integer('heart_rate_x100'), valid: integer('valid', { mode: 'boolean' }).notNull(), resultJson: text('result_json').notNull(), ...timestamps,
});

export const diagnosticResultRecords = sqliteTable('diagnostic_result_records', {
  id: id(),
  tenantId: tenantId(),
  testId: text('test_id').notNull().references(() => tests.id),
  recordedAt: text('recorded_at').notNull(),
  snapshotSchema: text('snapshot_schema').notNull(),
  canonicalization: text('canonicalization').notNull(),
  resultHash: text('result_hash').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
}, (table) => [
  uniqueIndex('diagnostic_result_record_tenant_id_uq').on(table.tenantId, table.id),
  uniqueIndex('diagnostic_result_record_tenant_test_hash_uq').on(table.tenantId, table.testId, table.resultHash),
]);

export const interpretations = sqliteTable('interpretations', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id), versionNumber: integer('version_number').notNull(),
  lt1Json: text('lt1_json').notNull(), lt2Json: text('lt2_json').notNull(), rationale: text('rationale'), status: text('status', { enum: ['DRAFT','RELEASED'] }).notNull(),
  releasedAt: text('released_at'), releasedByUserId: text('released_by_user_id'), ...timestamps,
}, (t) => [uniqueIndex('interpretation_test_version_uq').on(t.tenantId, t.testId, t.versionNumber)]);

export const zoneProfiles = sqliteTable('zone_profiles', {
  id: id(), tenantId: tenantId(), interpretationId: text('interpretation_id').notNull().references(() => interpretations.id),
  modelType: text('model_type', { enum: ['THREE_ZONE','FIVE_ZONE'] }).notNull(), powerZonesJson: text('power_zones_json').notNull(), heartRateZonesJson: text('heart_rate_zones_json').notNull(), ruleVersion: text('rule_version').notNull(), ...timestamps,
});

export const reportVersions = sqliteTable('report_versions', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id), interpretationId: text('interpretation_id').notNull().references(() => interpretations.id),
  versionNumber: integer('version_number').notNull(), locale: text('locale', { enum: ['de','en'] }).notNull(), contentHash: text('content_hash').notNull(), storageReference: text('storage_reference').notNull(), ...timestamps,
});
