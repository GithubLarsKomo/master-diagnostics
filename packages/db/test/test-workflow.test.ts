import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  getTestForExecution,
  listTestsForExecution,
} from '../src/services/test-workflow';

async function createTestDatabase(): Promise<Database> {
  const path = `/tmp/masters-test-workflow-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${path}` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

describe('test workflow queries', () => {
  it('lists and loads complete execution context only inside the tenant', async () => {
    const db = await createTestDatabase();
    const now = '2026-07-30T09:00:00.000Z';
    const athlete = (id: string, tenantId: string, firstName: string) => ({
      id, tenantId, firstName, lastName: 'Muster', birthDate: '1990-01-01',
      referenceCategory: 'Masters A', heightCm: 180, currentWeightKgX100: 7500,
      primarySport: 'Rudern', primaryDiscipline: 'Einer',
      trainingStatus: 'leistungsorientiert', createdAt: now, updatedAt: now,
    });
    await db.insert(schema.athletes).values([
      athlete('athlete-a', 'tenant-a', 'Petra'),
      athlete('athlete-b', 'tenant-b', 'Fremd'),
    ]);
    const test = (id: string, tenantId: string, athleteId: string) => ({
      id, tenantId, athleteId, deviceType: 'BIKEERG' as const,
      status: 'PLANNED' as const, conductingTrainerUserId: 'trainer-a',
      currentVersion: 1, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.tests).values([
      test('test-a', 'tenant-a', 'athlete-a'),
      test('test-b', 'tenant-b', 'athlete-b'),
    ]);
    const snapshot = (id: string, tenantId: string, testId: string) => ({
      id, tenantId, testId, protocolVersionId: `protocol-${tenantId}`,
      athleteSnapshotId: `snapshot-${tenantId}`, expectedLt2Watts: 350,
      startWatts: 210, incrementWatts: 35, maximumStages: 7,
      snapshotJson: '{}', createdAt: now, updatedAt: now,
    });
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
});
