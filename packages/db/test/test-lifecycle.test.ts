import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { startTest } from '../src/services/test-lifecycle';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-lifecycle-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_safety_checklist_confirmations (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, checklist_version TEXT NOT NULL, confirmations_json TEXT NOT NULL, confirmed_by_user_id TEXT NOT NULL, confirmed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedLifecycleContext(db: Database): Promise<void> {
  const now = '2026-07-30T09:00:00.000Z';
  await db.insert(schema.athletes).values([
    {
      id: 'athlete-a', tenantId: 'tenant-a', firstName: 'Petra', lastName: 'Muster',
      birthDate: '1992-04-18', referenceCategory: 'Masters A', heightCm: 174,
      currentWeightKgX100: 6850, primarySport: 'Rudern', primaryDiscipline: 'Einer',
      trainingStatus: 'leistungsorientiert', createdAt: now, updatedAt: now,
    },
    {
      id: 'athlete-blocked', tenantId: 'tenant-a', firstName: 'Berta', lastName: 'Blockiert',
      birthDate: '1988-02-12', referenceCategory: 'Masters B', heightCm: 168,
      currentWeightKgX100: 6200, primarySport: 'Radsport', primaryDiscipline: 'Straße',
      trainingStatus: 'ambitioniert', consentBlockedAt: now, createdAt: now, updatedAt: now,
    },
    {
      id: 'athlete-b', tenantId: 'tenant-b', firstName: 'Fremd', lastName: 'Tenant',
      birthDate: '1990-01-01', referenceCategory: 'Masters A', heightCm: 180,
      currentWeightKgX100: 7500, primarySport: 'Rudern', primaryDiscipline: 'Einer',
      trainingStatus: 'ambitioniert', createdAt: now, updatedAt: now,
    },
  ]);
  await db.insert(schema.coachAthleteAssignments).values([
    {
      id: 'assignment-a', tenantId: 'tenant-a', athleteId: 'athlete-a',
      coachUserId: 'trainer-a', isPrimary: true, validFrom: now,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'assignment-blocked', tenantId: 'tenant-a', athleteId: 'athlete-blocked',
      coachUserId: 'trainer-a', isPrimary: true, validFrom: now,
      createdAt: now, updatedAt: now,
    },
  ]);

  const plannedTest = (id: string, athleteId = 'athlete-a', trainerId = 'trainer-a') => ({
    id, tenantId: 'tenant-a', athleteId, deviceType: 'BIKEERG' as const,
    status: 'PLANNED' as const, conductingTrainerUserId: trainerId, currentVersion: 1,
    createdAt: now, updatedAt: now,
  });
  await db.insert(schema.tests).values([
    plannedTest('test-ready'),
    plannedTest('test-no-safety'),
    plannedTest('test-no-plan'),
    plannedTest('test-blocked', 'athlete-blocked'),
    plannedTest('test-unassigned', 'athlete-a', 'trainer-unassigned'),
    {
      ...plannedTest('test-running'), status: 'IN_PROGRESS' as const, startedAt: now,
    },
    {
      id: 'test-b', tenantId: 'tenant-b', athleteId: 'athlete-b', deviceType: 'ROWERG',
      status: 'PLANNED', conductingTrainerUserId: 'trainer-b', currentVersion: 1,
      createdAt: now, updatedAt: now,
    },
  ]);

  const plan = (testId: string, tenantId = 'tenant-a') => ({
    id: `plan-${testId}`, tenantId, testId, protocolVersionId: `protocol-${tenantId}`,
    athleteSnapshotId: `athlete-snapshot-${testId}`, expectedLt2Watts: 350,
    startWatts: 210, incrementWatts: 35, maximumStages: 7,
    snapshotJson: '{}', createdAt: now, updatedAt: now,
  });
  await db.insert(schema.testPlanSnapshots).values([
    plan('test-ready'),
    plan('test-no-safety'),
    plan('test-blocked'),
    plan('test-unassigned'),
    plan('test-running'),
    plan('test-b', 'tenant-b'),
  ]);

  const safety = (testId: string, trainerId = 'trainer-a', tenantId = 'tenant-a') => ({
    id: `safety-${testId}`, tenantId, testId,
    checklistVersion: 'TEST_START_SAFETY_V1', confirmationsJson: '{}',
    confirmedByUserId: trainerId, confirmedAt: now, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.testSafetyChecklistConfirmations).values([
    safety('test-ready'),
    safety('test-no-plan'),
    safety('test-blocked'),
    safety('test-unassigned', 'trainer-unassigned'),
    safety('test-running'),
    safety('test-b', 'trainer-b', 'tenant-b'),
  ]);
}

const trainer = { userId: 'trainer-a', role: 'TRAINER' };

describe('test lifecycle start transition', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedLifecycleContext(db);
  });

  it('atomically starts a ready planned test and audits the transition', async () => {
    const started = await startTest(db, 'tenant-a', trainer, 'test-ready');

    expect(started).toMatchObject({
      id: 'test-ready',
      tenantId: 'tenant-a',
      status: 'IN_PROGRESS',
      conductingTrainerUserId: 'trainer-a',
      currentVersion: 2,
    });
    expect(started.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [audit] = await db.select().from(schema.auditEvents);
    expect(audit).toMatchObject({
      tenantId: 'tenant-a',
      actorUserId: 'trainer-a',
      action: 'test.started',
      entityType: 'test',
      entityId: 'test-ready',
    });
    expect(JSON.parse(audit!.beforeJson!)).toEqual({ status: 'PLANNED', version: 1 });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({
      status: 'IN_PROGRESS',
      version: 2,
      planSnapshotId: 'plan-test-ready',
      safetyConfirmationId: 'safety-test-ready',
    });

    await expect(startTest(db, 'tenant-a', trainer, 'test-ready'))
      .rejects.toThrow('cannot start from status IN_PROGRESS');
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
  });

  it('rejects every missing readiness prerequisite without partial writes', async () => {
    await expect(startTest(db, 'tenant-a', { userId: 'athlete-a', role: 'ATHLETE' }, 'test-ready'))
      .rejects.toThrow('Only trainers and tenant admins');
    await expect(startTest(db, 'tenant-a', { userId: 'trainer-other', role: 'TRAINER' }, 'test-ready'))
      .rejects.toThrow('Only the conducting trainer');
    await expect(startTest(db, 'tenant-a', trainer, 'test-b'))
      .rejects.toThrow('Planned test not found');
    await expect(startTest(db, 'tenant-a', trainer, 'test-no-safety'))
      .rejects.toThrow('safety checklist confirmation is required');
    await expect(startTest(db, 'tenant-a', trainer, 'test-no-plan'))
      .rejects.toThrow('test plan snapshot is required');
    await expect(startTest(db, 'tenant-a', trainer, 'test-blocked'))
      .rejects.toThrow('blocked from diagnostic use');
    await expect(startTest(
      db,
      'tenant-a',
      { userId: 'trainer-unassigned', role: 'TRAINER' },
      'test-unassigned',
    )).rejects.toThrow('not assigned to athlete');
    await expect(startTest(db, 'tenant-a', trainer, 'test-running'))
      .rejects.toThrow('cannot start from status IN_PROGRESS');

    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
    const testRows = await db.select().from(schema.tests);
    expect(testRows.filter((test) => test.status === 'IN_PROGRESS')).toHaveLength(1);
    expect(testRows.find((test) => test.id === 'test-ready')).toMatchObject({
      status: 'PLANNED', currentVersion: 1, startedAt: null,
    });
  });

  it('allows a conducting tenant admin without a trainer assignment', async () => {
    const started = await startTest(
      db,
      'tenant-a',
      { userId: 'trainer-unassigned', role: 'TENANT_ADMIN' },
      'test-unassigned',
    );

    expect(started).toMatchObject({ status: 'IN_PROGRESS', currentVersion: 2 });
  });
});
