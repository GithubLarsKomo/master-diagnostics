import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps, version } from './common';
import { athletes, athleteSnapshots } from './athletes';
import { protocolTemplateVersions } from './protocols';

export const tests = sqliteTable('tests', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  deviceType: text('device_type', { enum: ['BIKEERG','ROWERG','RP3'] }).notNull(),
  status: text('status', { enum: ['PLANNED','IN_PROGRESS','DATA_REVIEW','INTERPRETED','RELEASED','ARCHIVED'] }).notNull(),
  conductingTrainerUserId: text('conducting_trainer_user_id').notNull(), scheduledAt: text('scheduled_at'), startedAt: text('started_at'), endedAt: text('ended_at'),
  currentVersion: version(), releasedAt: text('released_at'), ...timestamps,
});

export const testPlanSnapshots = sqliteTable('test_plan_snapshots', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id),
  protocolVersionId: text('protocol_version_id').notNull().references(() => protocolTemplateVersions.id),
  athleteSnapshotId: text('athlete_snapshot_id').notNull().references(() => athleteSnapshots.id),
  expectedLt2Watts: integer('expected_lt2_watts').notNull(), startWatts: integer('start_watts').notNull(),
  incrementWatts: integer('increment_watts').notNull(), maximumStages: integer('maximum_stages').notNull(),
  snapshotJson: text('snapshot_json').notNull(), ...timestamps,
}, (t) => [uniqueIndex('test_plan_snapshot_test_uq').on(t.tenantId, t.testId)]);

export const testSafetyChecklistConfirmations = sqliteTable('test_safety_checklist_confirmations', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id),
  checklistVersion: text('checklist_version').notNull(), confirmationsJson: text('confirmations_json').notNull(),
  confirmedByUserId: text('confirmed_by_user_id').notNull(), confirmedAt: text('confirmed_at').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('test_safety_checklist_test_uq').on(t.tenantId, t.testId)]);

export const testStages = sqliteTable('test_stages', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id), stageNumber: integer('stage_number').notNull(),
  targetWatts: integer('target_watts').notNull(), plannedSeconds: integer('planned_seconds').notNull(), actualSeconds: integer('actual_seconds'),
  meanWatts: integer('mean_watts'), endWatts: integer('end_watts'), meanHeartRate: integer('mean_heart_rate'), endHeartRate: integer('end_heart_rate'),
  meanCadence: integer('mean_cadence'), endCadence: integer('end_cadence'), distanceMeters: integer('distance_meters'),
  lactateValueX100: integer('lactate_value_x100'), lactateQualifier: text('lactate_qualifier', { enum: ['EXACT','LESS_THAN','GREATER_THAN'] }),
  rpeX10: integer('rpe_x10'), qualityStatus: text('quality_status', { enum: ['VALID','PARTIAL','EXCLUDED','MISSING','MANUALLY_CORRECTED'] }).notNull().default('MISSING'),
  dataSource: text('data_source', { enum: ['MANUAL','BLUETOOTH','SYSTEM_DERIVED'] }).notNull().default('MANUAL'), notes: text('notes'), currentVersion: version(), ...timestamps,
}, (t) => [uniqueIndex('test_stage_number_uq').on(t.tenantId, t.testId, t.stageNumber)]);

export const restMeasurements = sqliteTable('rest_measurements', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id),
  heartRate: integer('heart_rate'), lactateValueX100: integer('lactate_value_x100'), lactateQualifier: text('lactate_qualifier'), measuredAt: text('measured_at'), ...timestamps,
});

export const recoveryMeasurements = sqliteTable('recovery_measurements', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id),
  targetOffsetSeconds: integer('target_offset_seconds').notNull().default(300), actualOffsetSeconds: integer('actual_offset_seconds'),
  heartRate: integer('heart_rate'), lactateValueX100: integer('lactate_value_x100'), lactateQualifier: text('lactate_qualifier'), measuredAt: text('measured_at'), ...timestamps,
});

export const testLocks = sqliteTable('test_locks', {
  id: id(), tenantId: tenantId(), testId: text('test_id').notNull().references(() => tests.id),
  ownerUserId: text('owner_user_id').notNull(), tokenHash: text('token_hash').notNull(), acquiredAt: text('acquired_at').notNull(), expiresAt: text('expires_at').notNull(), ...timestamps,
}, (t) => [uniqueIndex('test_lock_test_uq').on(t.tenantId, t.testId)]);
