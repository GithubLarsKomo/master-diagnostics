import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  getTestForExecution,
  listTestsForExecution,
  listTestsForTrainerDashboard,
} from '../src/services/test-workflow';

async function createTestDatabase(): Promise<Database> {
  const path = `/tmp/masters-test-workflow-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${path}` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

const now = '2026-07-30T09:00:00.000Z';

const athlete = (id: string, tenantId: string, firstName: string) => ({
  id, tenantId, firstName, lastName: 'Muster', birthDate: '1990-01-01',
  referenceCategory: 'Masters A', heightCm: 180, currentWeightKgX100: 7500,
  primarySport: 'Rudern', primaryDiscipline: 'Einer',
  trainingStatus: 'leistungsorientiert', createdAt: now, updatedAt: now,
});

const test = (id: string, tenantId: string, athleteId: string, status: 'PLANNED' | 'IN_PROGRESS' = 'PLANNED') => ({
  id, tenantId, athleteId, deviceType: 'BIKEERG' as const,
  status, conductingTrainerUserId: 'trainer-a',
  currentVersion: 1, createdAt: now, updatedAt: now,
});

const snapshot = (id: string, tenantId: string, testId: string) => ({
  id, tenantId, testId, protocolVersionId: `protocol-${tenantId}`,
  athleteSnapshotId: `snapshot-${id}`, expectedLt2Watts: 350,
  startWatts: 210, incrementWatts: 35, maximumStages: 7,
  snapshotJson: '{}', createdAt: now, updatedAt: now,
});

describe('test workflow queries', () => {
  it('lists and loads complete execution context only inside the tenant', async () => {
    const db = await createTestDatabase();
    await db.insert(schema.athletes).values([
      athlete('athlete-a', 'tenant-a', 'Petra'),
      athlete('athlete-b', 'tenant-b', 'Fremd'),
    ]);
    await db.insert(schema.tests).values([
      test('test-a', 'tenant-a', 'athlete-a'),
      test('test-b', 'tenant-b', 'athlete-b'),
    ]);
    await db.insert(schema.testPlanSnapshots).values([
      snapshot('plan-a', 'tenant-a', 'test-a'),
      snapshot('plan-b', 'tenant-b', 'test-b'),
    ]);

    expect(await listTestsForExecution(db, 'tenant-a')).toEqual([
      expect.objectContaining({
        test: expect.objectContaining({ id: 'test-a', tenantId: 'tenant-a' }),
        athlete: { id: 'athlete-a', firstName: 'Petra', lastName: 'Muster' },
        plan: { expectedLt2Watts: 350, startWatts: 210, incrementWatts: 35, maximumStages: 7 },
      }),
    ]);
    expect(await getTestForExecution(db, 'tenant-a', 'test-a')).not.toBeNull();
    expect(await getTestForExecution(db, 'tenant-a', 'test-b')).toBeNull();
  });

  it('limits trainer dashboard rows to active assignments inside the tenant', async () => {
    const db = await createTestDatabase();
    await db.insert(schema.athletes).values([
      athlete('assigned', 'tenant-a', 'Assigned'),
      athlete('unassigned', 'tenant-a', 'Unassigned'),
      athlete('expired', 'tenant-a', 'Expired'),
      athlete('foreign', 'tenant-b', 'Foreign'),
    ]);
    await db.insert(schema.tests).values([
      test('test-assigned', 'tenant-a', 'assigned', 'IN_PROGRESS'),
      test('test-unassigned', 'tenant-a', 'unassigned'),
      test('test-expired', 'tenant-a', 'expired'),
      test('test-foreign', 'tenant-b', 'foreign'),
    ]);
    await db.insert(schema.testPlanSnapshots).values([
      snapshot('plan-assigned', 'tenant-a', 'test-assigned'),
      snapshot('plan-unassigned', 'tenant-a', 'test-unassigned'),
      snapshot('plan-expired', 'tenant-a', 'test-expired'),
      snapshot('plan-foreign', 'tenant-b', 'test-foreign'),
    ]);
    await db.insert(schema.coachAthleteAssignments).values([
      { id: 'assignment-active', tenantId: 'tenant-a', athleteId: 'assigned', coachUserId: 'trainer-a', isPrimary: true, validFrom: now, createdAt: now, updatedAt: now },
      { id: 'assignment-expired', tenantId: 'tenant-a', athleteId: 'expired', coachUserId: 'trainer-a', isPrimary: false, validFrom: now, validUntil: '2026-07-31T00:00:00.000Z', createdAt: now, updatedAt: now },
      { id: 'assignment-foreign', tenantId: 'tenant-b', athleteId: 'foreign', coachUserId: 'trainer-a', isPrimary: true, validFrom: now, createdAt: now, updatedAt: now },
    ]);

    const rows = await listTestsForTrainerDashboard(db, 'tenant-a', { userId: 'trainer-a', role: 'TRAINER' });
    expect(rows.map(({ test: row }) => row.id)).toEqual(['test-assigned']);
  });

  it('lets tenant admins see tenant-wide dashboard rows but never another tenant', async () => {
    const db = await createTestDatabase();
    await db.insert(schema.athletes).values([
      athlete('athlete-a1', 'tenant-a', 'A-One'),
      athlete('athlete-a2', 'tenant-a', 'A-Two'),
      athlete('athlete-b', 'tenant-b', 'B-One'),
    ]);
    await db.insert(schema.tests).values([
      test('test-a1', 'tenant-a', 'athlete-a1'),
      test('test-a2', 'tenant-a', 'athlete-a2', 'IN_PROGRESS'),
      test('test-b', 'tenant-b', 'athlete-b'),
    ]);
    await db.insert(schema.testPlanSnapshots).values([
      snapshot('plan-a1', 'tenant-a', 'test-a1'),
      snapshot('plan-a2', 'tenant-a', 'test-a2'),
      snapshot('plan-b', 'tenant-b', 'test-b'),
    ]);

    const rows = await listTestsForTrainerDashboard(db, 'tenant-a', { userId: 'admin-a', role: 'TENANT_ADMIN' });
    expect(rows.map(({ test: row }) => row.id).sort()).toEqual(['test-a1', 'test-a2']);
  });
});
