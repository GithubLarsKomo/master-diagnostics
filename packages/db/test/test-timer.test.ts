import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { getTestTimerPlan } from '../src/services/test-timer';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-timer-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

function frozenSnapshot(configJson = JSON.stringify({ audioWarningSeconds: [30, 10, 3] })) {
  return JSON.stringify({
    schemaVersion: 1,
    protocolVersion: {
      warmupSeconds: 600,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 30,
      recoverySeconds: 300,
      configJson,
    },
    plan: {
      powersWatts: [210, 245, 280, 315, 350, 385, 420],
    },
  });
}

async function seedTimerContext(db: Database): Promise<void> {
  const now = '2026-07-30T09:00:00.000Z';
  await db.insert(schema.tests).values([
    {
      id: 'test-running', tenantId: 'tenant-a', athleteId: 'athlete-a',
      deviceType: 'BIKEERG', status: 'IN_PROGRESS',
      conductingTrainerUserId: 'trainer-a', startedAt: now, currentVersion: 2,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-other-conductor', tenantId: 'tenant-a', athleteId: 'athlete-a',
      deviceType: 'ROWERG', status: 'PLANNED',
      conductingTrainerUserId: 'trainer-other', currentVersion: 1,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-invalid', tenantId: 'tenant-a', athleteId: 'athlete-a',
      deviceType: 'RP3', status: 'IN_PROGRESS',
      conductingTrainerUserId: 'trainer-a', startedAt: now, currentVersion: 2,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-b', tenantId: 'tenant-b', athleteId: 'athlete-b',
      deviceType: 'BIKEERG', status: 'IN_PROGRESS',
      conductingTrainerUserId: 'trainer-b', startedAt: now, currentVersion: 2,
      createdAt: now, updatedAt: now,
    },
  ]);

  const snapshot = (
    id: string,
    tenantId: string,
    testId: string,
    snapshotJson: string,
  ) => ({
    id, tenantId, testId, protocolVersionId: `protocol-${id}`,
    athleteSnapshotId: `athlete-${id}`, expectedLt2Watts: 350,
    startWatts: 210, incrementWatts: 35, maximumStages: 7,
    snapshotJson, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.testPlanSnapshots).values([
    snapshot('snapshot-running', 'tenant-a', 'test-running', frozenSnapshot()),
    snapshot('snapshot-other', 'tenant-a', 'test-other-conductor', frozenSnapshot()),
    snapshot('snapshot-invalid', 'tenant-a', 'test-invalid', '{not-json'),
    snapshot('snapshot-b', 'tenant-b', 'test-b', frozenSnapshot()),
  ]);
}

const trainer = { userId: 'trainer-a', role: 'TRAINER' };

describe('snapshot-backed test timer', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedTimerContext(db);
  });

  it('reconstructs the complete timer only from the immutable plan snapshot', async () => {
    const timer = await getTestTimerPlan(db, 'tenant-a', trainer, 'test-running');

    expect(timer).toMatchObject({
      schemaVersion: 1,
      stageCount: 7,
      totalDurationSeconds: 3_120,
      warningSeconds: [30, 10, 3],
    });
    expect(timer.phases.filter((phase) => phase.kind === 'STAGE').map((phase) => ({
      stageNumber: phase.stageNumber,
      targetWatts: phase.targetWatts,
    }))).toEqual([
      { stageNumber: 1, targetWatts: 210 },
      { stageNumber: 2, targetWatts: 245 },
      { stageNumber: 3, targetWatts: 280 },
      { stageNumber: 4, targetWatts: 315 },
      { stageNumber: 5, targetWatts: 350 },
      { stageNumber: 6, targetWatts: 385 },
      { stageNumber: 7, targetWatts: 420 },
    ]);
  });

  it('allows tenant-scoped read access but rejects unauthorized and cross-tenant access', async () => {
    await expect(getTestTimerPlan(
      db, 'tenant-a', { userId: 'viewer-a', role: 'VIEWER' }, 'test-running',
    )).rejects.toThrow('Only trainers and tenant admins');
    await expect(getTestTimerPlan(
      db, 'tenant-a', trainer, 'test-other-conductor',
    )).resolves.toMatchObject({ stageCount: 7 });
    await expect(getTestTimerPlan(
      db, 'tenant-a', trainer, 'test-b',
    )).rejects.toThrow('Test timer context not found');
  });

  it('fails closed when the immutable snapshot cannot reproduce the timer', async () => {
    await expect(getTestTimerPlan(
      db, 'tenant-a', trainer, 'test-invalid',
    )).rejects.toThrow('Immutable test plan snapshot is invalid');
  });
});
