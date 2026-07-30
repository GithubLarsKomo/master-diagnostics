import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  syncTestMeasurement as syncTestMeasurementWithLock,
  type TestMeasurementSyncOperation,
} from '../src/services/test-measurement-sync';
import { hashTestLockToken } from '../src/services/test-locks';

const lockToken = '11111111-1111-4111-8111-111111111111';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-measurement-sync-${crypto.randomUUID()}.db`;
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
    `CREATE TABLE sync_operations (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, test_id TEXT NOT NULL, entity_id TEXT NOT NULL, expected_version INTEGER NOT NULL, occurred_at TEXT NOT NULL, operation_type TEXT NOT NULL, schema_version TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, applied_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX sync_operation_uq ON sync_operations (operation_id)`,
    `CREATE TABLE test_locks (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_lock_test_uq ON test_locks (tenant_id, test_id)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

function frozenSnapshot() {
  return JSON.stringify({
    schemaVersion: 1,
    protocolVersion: {
      warmupSeconds: 600,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 30,
      recoverySeconds: 300,
      configJson: JSON.stringify({ audioWarningSeconds: [30, 10, 3] }),
    },
    plan: { powersWatts: [210, 245, 280, 315, 350, 385, 420] },
  });
}

async function seedContext(db: Database): Promise<void> {
  const now = '2026-07-30T09:00:00.000Z';
  await db.insert(schema.tests).values([
    {
      id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a',
      deviceType: 'BIKEERG', status: 'IN_PROGRESS',
      conductingTrainerUserId: 'trainer-a', startedAt: now, currentVersion: 2,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-b', tenantId: 'tenant-b', athleteId: 'athlete-b',
      deviceType: 'ROWERG', status: 'IN_PROGRESS',
      conductingTrainerUserId: 'trainer-b', startedAt: now, currentVersion: 2,
      createdAt: now, updatedAt: now,
    },
  ]);
  await db.insert(schema.testPlanSnapshots).values([
    {
      id: 'snapshot-a', tenantId: 'tenant-a', testId: 'test-a',
      protocolVersionId: 'protocol-a', athleteSnapshotId: 'athlete-snapshot-a',
      expectedLt2Watts: 350, startWatts: 210, incrementWatts: 35,
      maximumStages: 7, snapshotJson: frozenSnapshot(), createdAt: now, updatedAt: now,
    },
    {
      id: 'snapshot-b', tenantId: 'tenant-b', testId: 'test-b',
      protocolVersionId: 'protocol-b', athleteSnapshotId: 'athlete-snapshot-b',
      expectedLt2Watts: 350, startWatts: 210, incrementWatts: 35,
      maximumStages: 7, snapshotJson: frozenSnapshot(), createdAt: now, updatedAt: now,
    },
  ]);
  await db.insert(schema.testLocks).values({
    id: 'lock-a',
    tenantId: 'tenant-a',
    testId: 'test-a',
    ownerUserId: 'trainer-a',
    tokenHash: hashTestLockToken(lockToken),
    acquiredAt: now,
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: now,
    updatedAt: now,
  });
}

function operation(
  overrides: Partial<TestMeasurementSyncOperation> = {},
): TestMeasurementSyncOperation {
  return {
    operationId: crypto.randomUUID(),
    testId: 'test-a',
    entityId: 'STAGE:1',
    expectedVersion: 0,
    occurredAt: '2026-07-30T09:10:00.000Z',
    operationType: 'TEST_MEASUREMENT_UPSERT',
    schemaVersion: '1',
    payload: {
      target: { kind: 'STAGE', stageNumber: 1 },
      lactateValueX100: 180,
      lactateQualifier: 'EXACT',
      heartRate: 128,
      measuredAt: '2026-07-30T09:09:30.000Z',
    },
    ...overrides,
  };
}

const trainer = { userId: 'trainer-a', role: 'TRAINER' };

function syncTestMeasurement(
  db: Database,
  tenantId: string,
  actor: { userId: string; role: string },
  input: TestMeasurementSyncOperation,
) {
  return syncTestMeasurementWithLock(db, tenantId, actor, input, lockToken);
}

describe('test measurement synchronization', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedContext(db);
  });

  it('applies a stage operation exactly once and audits the server write', async () => {
    const input = operation();
    const first = await syncTestMeasurement(db, 'tenant-a', trainer, input);
    const retry = await syncTestMeasurement(db, 'tenant-a', trainer, input);

    expect(first).toEqual({ status: 'APPLIED', newVersion: 1 });
    expect(retry).toEqual(first);
    expect(await db.select().from(schema.syncOperations)).toHaveLength(1);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
    const [stage] = await db.select().from(schema.testStages);
    expect(stage).toMatchObject({
      tenantId: 'tenant-a',
      testId: 'test-a',
      stageNumber: 1,
      targetWatts: 210,
      plannedSeconds: 240,
      endHeartRate: 128,
      lactateValueX100: 180,
      lactateQualifier: 'EXACT',
      lactateMeasuredAt: '2026-07-30T09:09:30.000Z',
      currentVersion: 1,
    });
    const [audit] = await db.select().from(schema.auditEvents);
    expect(audit).toMatchObject({
      tenantId: 'tenant-a',
      actorUserId: 'trainer-a',
      action: 'test.measurement.synced',
      entityType: 'test_measurement.stage',
      source: 'OFFLINE_SYNC',
      correlationId: input.operationId,
    });
  });

  it('creates and version-updates unique rest and recovery measurements', async () => {
    const rest = operation({
      entityId: 'REST',
      payload: {
        target: { kind: 'REST', stageNumber: null },
        lactateValueX100: 120,
        lactateQualifier: 'LESS_THAN',
        heartRate: 52,
        measuredAt: '2026-07-30T09:00:00.000Z',
      },
    });
    expect(await syncTestMeasurement(db, 'tenant-a', trainer, rest)).toEqual({
      status: 'APPLIED', newVersion: 1,
    });
    expect(await syncTestMeasurement(db, 'tenant-a', trainer, operation({
      entityId: 'REST',
      expectedVersion: 1,
      payload: {
        ...rest.payload,
        lactateValueX100: 130,
        lactateQualifier: 'EXACT',
      },
    }))).toEqual({ status: 'APPLIED', newVersion: 2 });

    expect(await syncTestMeasurement(db, 'tenant-a', trainer, operation({
      entityId: 'RECOVERY',
      payload: {
        target: { kind: 'RECOVERY', stageNumber: null },
        lactateValueX100: null,
        lactateQualifier: null,
        heartRate: 88,
        measuredAt: '2026-07-30T10:00:00.000Z',
      },
    }))).toEqual({ status: 'APPLIED', newVersion: 1 });

    expect(await db.select().from(schema.restMeasurements)).toHaveLength(1);
    expect((await db.select().from(schema.restMeasurements))[0]).toMatchObject({
      lactateValueX100: 130, currentVersion: 2,
    });
    expect(await db.select().from(schema.recoveryMeasurements)).toHaveLength(1);
  });

  it('records but never overwrites on an optimistic version conflict', async () => {
    const applied = operation();
    await syncTestMeasurement(db, 'tenant-a', trainer, applied);
    const stale = operation({
      expectedVersion: 0,
      payload: { ...applied.payload, lactateValueX100: 260 },
    });

    const conflict = await syncTestMeasurement(db, 'tenant-a', trainer, stale);
    expect(conflict).toMatchObject({
      status: 'CONFLICT',
      serverVersion: 1,
      serverState: { lactateValueX100: 180, currentVersion: 1 },
    });
    expect((await db.select().from(schema.testStages))[0]).toMatchObject({
      lactateValueX100: 180, currentVersion: 1,
    });
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
    expect(
      await db.select().from(schema.syncOperations)
        .where(eq(schema.syncOperations.status, 'CONFLICT')),
    ).toHaveLength(1);
  });

  it('rejects operation-ID reuse, unauthorized actors, and cross-tenant tests', async () => {
    const applied = operation();
    await syncTestMeasurement(db, 'tenant-a', trainer, applied);
    await expect(syncTestMeasurement(db, 'tenant-a', trainer, {
      ...applied,
      payload: { ...applied.payload, heartRate: 140 },
    })).rejects.toThrow('reused with different content');
    await expect(syncTestMeasurement(
      db,
      'tenant-a',
      { userId: 'athlete-a', role: 'ATHLETE' },
      operation(),
    )).rejects.toThrow('Only trainers and tenant admins');
    await expect(syncTestMeasurement(
      db,
      'tenant-a',
      trainer,
      operation({ testId: 'test-b' }),
    )).rejects.toThrow('Test timer context not found');

    expect(await db.select().from(schema.testStages)).toHaveLength(1);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
  });

  it('rejects server writes without the active lease token', async () => {
    await expect(syncTestMeasurementWithLock(
      db,
      'tenant-a',
      trainer,
      operation(),
      '22222222-2222-4222-8222-222222222222',
    )).rejects.toThrow('active test lock');
    await db.update(schema.testLocks).set({
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    await expect(syncTestMeasurementWithLock(
      db,
      'tenant-a',
      trainer,
      operation(),
      lockToken,
    )).rejects.toThrow('active test lock');
    expect(await db.select().from(schema.testStages)).toHaveLength(0);
    expect(await db.select().from(schema.syncOperations)).toHaveLength(0);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });
});
