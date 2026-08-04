import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  correctTestMeasurement,
  getTestReviewRows,
  type CorrectTestMeasurementInput,
} from '../src/services/test-review';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-review-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_stages (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, stage_number INTEGER NOT NULL, target_watts INTEGER NOT NULL, planned_seconds INTEGER NOT NULL, actual_seconds INTEGER, mean_watts INTEGER, end_watts INTEGER, mean_heart_rate INTEGER, end_heart_rate INTEGER, mean_cadence INTEGER, end_cadence INTEGER, distance_meters INTEGER, lactate_value_x100 INTEGER, lactate_qualifier TEXT, lactate_measured_at TEXT, rpe_x10 INTEGER, quality_status TEXT DEFAULT 'MISSING' NOT NULL, data_source TEXT DEFAULT 'MANUAL' NOT NULL, notes TEXT, version INTEGER DEFAULT 1 NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_stage_number_uq ON test_stages (tenant_id, test_id, stage_number)`,
    `CREATE TABLE rest_measurements (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, heart_rate INTEGER, lactate_value_x100 INTEGER, lactate_qualifier TEXT, measured_at TEXT, version INTEGER DEFAULT 1 NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX rest_measurement_test_uq ON rest_measurements (tenant_id, test_id)`,
    `CREATE TABLE recovery_measurements (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, target_offset_seconds INTEGER DEFAULT 300 NOT NULL, actual_offset_seconds INTEGER, heart_rate INTEGER, lactate_value_x100 INTEGER, lactate_qualifier TEXT, measured_at TEXT, version INTEGER DEFAULT 1 NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX recovery_measurement_test_uq ON recovery_measurements (tenant_id, test_id)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

const now = '2026-07-30T10:00:00.000Z';
const trainer = {
  userId: 'trainer-a',
  role: 'TRAINER',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'session-review-a',
};

function snapshotJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    protocolVersion: { stageSeconds: 240 },
  });
}

async function seedContext(db: Database): Promise<void> {
  await db.insert(schema.tests).values([
    {
      id: 'test-review', tenantId: 'tenant-a', athleteId: 'athlete-a',
      deviceType: 'BIKEERG', status: 'DATA_REVIEW',
      conductingTrainerUserId: trainer.userId, startedAt: now, endedAt: now,
      currentVersion: 3, createdAt: now, updatedAt: now,
    },
    {
      id: 'test-running', tenantId: 'tenant-a', athleteId: 'athlete-a',
      deviceType: 'BIKEERG', status: 'IN_PROGRESS',
      conductingTrainerUserId: trainer.userId, startedAt: now,
      currentVersion: 2, createdAt: now, updatedAt: now,
    },
    {
      id: 'test-other-tenant', tenantId: 'tenant-b', athleteId: 'athlete-b',
      deviceType: 'ROWERG', status: 'DATA_REVIEW',
      conductingTrainerUserId: 'trainer-b', startedAt: now, endedAt: now,
      currentVersion: 3, createdAt: now, updatedAt: now,
    },
  ]);
  const plan = (id: string, tenantId: string, testId: string) => ({
    id, tenantId, testId, protocolVersionId: `protocol-${id}`,
    athleteSnapshotId: `athlete-${id}`, expectedLt2Watts: 300,
    startWatts: 180, incrementWatts: 30, maximumStages: 3,
    snapshotJson: snapshotJson(), createdAt: now, updatedAt: now,
  });
  await db.insert(schema.testPlanSnapshots).values([
    plan('plan-review', 'tenant-a', 'test-review'),
    plan('plan-running', 'tenant-a', 'test-running'),
    plan('plan-other', 'tenant-b', 'test-other-tenant'),
  ]);
  await db.insert(schema.testStages).values({
    id: 'stage-1', tenantId: 'tenant-a', testId: 'test-review',
    stageNumber: 1, targetWatts: 180, plannedSeconds: 240,
    endHeartRate: 130, lactateValueX100: 180, lactateQualifier: 'EXACT',
    lactateMeasuredAt: '2026-07-30T10:04:00.000Z',
    qualityStatus: 'MISSING', currentVersion: 1,
    createdAt: now, updatedAt: now,
  });
}

function stageCorrection(
  overrides: Partial<CorrectTestMeasurementInput> = {},
): CorrectTestMeasurementInput {
  return {
    kind: 'STAGE',
    stageNumber: 1,
    expectedVersion: 1,
    heartRate: 130,
    lactateValueX100: 180,
    lactateQualifier: 'EXACT',
    measuredAt: '2026-07-30T10:04:00.000Z',
    qualityStatus: 'VALID',
    notes: null,
    reason: 'Plausibilitätsprüfung abgeschlossen',
    ...overrides,
  };
}

describe('post-test measurement review', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedContext(db);
  });

  it('returns rest, every planned stage and recovery including missing rows', async () => {
    const rows = await getTestReviewRows(
      db,
      'tenant-a',
      trainer,
      'test-review',
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => [row.kind, row.stageNumber, row.targetWatts]))
      .toEqual([
        ['REST', null, null],
        ['STAGE', 1, 180],
        ['STAGE', 2, 210],
        ['STAGE', 3, 240],
        ['RECOVERY', null, null],
      ]);
    expect(rows[1]).toMatchObject({
      plannedSeconds: 240,
      actualSeconds: null,
      heartRate: 130,
      lactateValueX100: 180,
      qualityStatus: 'MISSING',
      version: 1,
    });
    expect(rows[2]).toMatchObject({
      entityId: null,
      qualityStatus: 'MISSING',
      version: 0,
    });
  });

  it('marks changed stage values as manually corrected and audits both states', async () => {
    const result = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        heartRate: 134,
        lactateValueX100: 195,
        notes: 'Kontrollmessung',
        reason: 'Übertragungsfehler aus Messgerät korrigiert',
      }),
    );
    expect(result).toMatchObject({
      status: 'APPLIED',
      row: {
        heartRate: 134,
        lactateValueX100: 195,
        qualityStatus: 'MANUALLY_CORRECTED',
        notes: 'Kontrollmessung',
        version: 2,
      },
    });
    const [audit] = await db.select().from(schema.auditEvents);
    expect(audit).toMatchObject({
      tenantId: 'tenant-a',
      actorUserId: trainer.userId,
      action: 'test.measurement.corrected',
      entityType: 'test_measurement.stage',
      reason: 'Übertragungsfehler aus Messgerät korrigiert',
      source: 'WEB',
      authProvider: 'BETTER_AUTH',
      sessionId: 'session-review-a',
    });
    expect(JSON.parse(audit!.beforeJson!)).toMatchObject({
      lactateValueX100: 180,
      version: 1,
    });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({
      lactateValueX100: 195,
      qualityStatus: 'MANUALLY_CORRECTED',
      version: 2,
    });
  });

  it('documents exclusion and subsequent reinclusion without changing values', async () => {
    const excluded = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        qualityStatus: 'EXCLUDED',
        reason: 'Probe war während der Stufe kontaminiert',
      }),
    );
    expect(excluded).toMatchObject({
      status: 'APPLIED',
      row: { qualityStatus: 'EXCLUDED', version: 2 },
    });
    const included = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        expectedVersion: 2,
        qualityStatus: 'VALID',
        reason: 'Kontamination durch Kontrollmessung widerlegt',
      }),
    );
    expect(included).toMatchObject({
      status: 'APPLIED',
      row: { qualityStatus: 'VALID', version: 3 },
    });
    expect(await db.select().from(schema.auditEvents)).toHaveLength(2);
  });

  it('adds missing rest, stage and recovery values with immutable-plan data', async () => {
    const rest = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      {
        kind: 'REST', stageNumber: null, expectedVersion: 0,
        heartRate: 52, lactateValueX100: 110, lactateQualifier: 'EXACT',
        measuredAt: '2026-07-30T09:55:00.000Z',
        qualityStatus: null, notes: null, reason: 'Ruhewert nachgetragen',
      },
    );
    const stage = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        stageNumber: 2,
        expectedVersion: 0,
        heartRate: 145,
        lactateValueX100: 240,
        measuredAt: '2026-07-30T10:09:00.000Z',
        reason: 'Papierprotokoll nachgetragen',
      }),
    );
    const recovery = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      {
        kind: 'RECOVERY', stageNumber: null, expectedVersion: 0,
        heartRate: 88, lactateValueX100: null, lactateQualifier: null,
        measuredAt: '2026-07-30T10:30:00.000Z',
        qualityStatus: null, notes: null, reason: 'Erholungswert nachgetragen',
      },
    );
    expect(rest).toMatchObject({ status: 'APPLIED', row: { version: 1 } });
    expect(stage).toMatchObject({
      status: 'APPLIED',
      row: {
        targetWatts: 210,
        qualityStatus: 'MANUALLY_CORRECTED',
        version: 1,
      },
    });
    expect(recovery).toMatchObject({ status: 'APPLIED', row: { version: 1 } });
    const [createdStage] = await db.select().from(schema.testStages)
      .where(eq(schema.testStages.stageNumber, 2));
    expect(createdStage).toMatchObject({
      targetWatts: 210,
      plannedSeconds: 240,
    });
  });

  it('returns conflicts and rejects unauthorized, cross-tenant, running and invalid writes', async () => {
    await expect(correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({ expectedVersion: 0 }),
    )).resolves.toMatchObject({
      status: 'CONFLICT',
      row: { version: 1, lactateValueX100: 180 },
    });
    await expect(getTestReviewRows(
      db,
      'tenant-a',
      { userId: 'viewer-a', role: 'VIEWER' },
      'test-review',
    )).rejects.toThrow('Only trainers and tenant admins');
    await expect(getTestReviewRows(
      db,
      'tenant-a',
      { userId: 'trainer-b', role: 'TRAINER' },
      'test-review',
    )).rejects.toThrow('conducting trainer');
    await expect(getTestReviewRows(
      db,
      'tenant-a',
      trainer,
      'test-other-tenant',
    )).rejects.toThrow('context not found');
    await expect(getTestReviewRows(
      db,
      'tenant-a',
      trainer,
      'test-running',
    )).rejects.toThrow('cannot be reviewed');
    await expect(correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        qualityStatus: 'MISSING',
        reason: 'Ungültige Kombination',
      }),
    )).rejects.toThrow('missing stage');
    const missing = await correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        qualityStatus: 'MISSING',
        heartRate: null,
        lactateValueX100: null,
        lactateQualifier: null,
        measuredAt: null,
        reason: 'Messung wurde verworfen',
      }),
    );
    expect(missing).toMatchObject({
      status: 'APPLIED',
      row: { qualityStatus: 'MISSING', version: 2 },
    });
    await expect(correctTestMeasurement(
      db,
      'tenant-a',
      trainer,
      'test-review',
      stageCorrection({
        expectedVersion: 2,
        qualityStatus: 'MISSING',
        heartRate: null,
        lactateValueX100: null,
        lactateQualifier: null,
        measuredAt: null,
        reason: 'Unveränderte Messung erneut gesendet',
      }),
    )).rejects.toThrow('does not change');
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
  });
});
