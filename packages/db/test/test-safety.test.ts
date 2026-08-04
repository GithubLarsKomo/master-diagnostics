import { createClient } from '@libsql/client';
import {
  TEST_START_SAFETY_CHECKLIST_ITEMS,
  type TestStartSafetyChecklistConfirmation,
} from '@masters/domain';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  confirmTestSafetyChecklist,
  getTestStartReadiness,
} from '../src/services/test-safety';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-safety-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_safety_checklist_confirmations (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, checklist_version TEXT NOT NULL, confirmations_json TEXT NOT NULL, confirmed_by_user_id TEXT NOT NULL, confirmed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_safety_checklist_test_uq ON test_safety_checklist_confirmations (tenant_id, test_id)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TRIGGER test_safety_checklists_immutable_update BEFORE UPDATE ON test_safety_checklist_confirmations BEGIN SELECT RAISE(ABORT, 'test safety checklist confirmations are immutable'); END`,
    `CREATE TRIGGER test_safety_checklists_immutable_delete BEFORE DELETE ON test_safety_checklist_confirmations BEGIN SELECT RAISE(ABORT, 'test safety checklist confirmations are immutable'); END`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedTestContext(db: Database): Promise<void> {
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
  await db.insert(schema.tests).values([
    {
      id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'BIKEERG',
      status: 'PLANNED', conductingTrainerUserId: 'trainer-a', currentVersion: 1,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-no-plan', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'BIKEERG',
      status: 'PLANNED', conductingTrainerUserId: 'trainer-a', currentVersion: 1,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-blocked', tenantId: 'tenant-a', athleteId: 'athlete-blocked', deviceType: 'BIKEERG',
      status: 'PLANNED', conductingTrainerUserId: 'trainer-a', currentVersion: 1,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-running', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'BIKEERG',
      status: 'IN_PROGRESS', conductingTrainerUserId: 'trainer-a', currentVersion: 1,
      createdAt: now, updatedAt: now,
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
    plan('test-a'),
    plan('test-blocked'),
    plan('test-running'),
    plan('test-b', 'tenant-b'),
  ]);
}

const trainer = { userId: 'trainer-a', role: 'TRAINER' };
const completeChecklist = Object.fromEntries(
  TEST_START_SAFETY_CHECKLIST_ITEMS.map((item) => [item, true]),
) as TestStartSafetyChecklistConfirmation;

describe('test safety start gate', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedTestContext(db);
  });

  it('records all confirmations once and makes the planned test ready', async () => {
    expect(await getTestStartReadiness(db, 'tenant-a', 'test-a')).toEqual({
      ready: false,
      blockers: ['SAFETY_CHECKLIST_NOT_CONFIRMED'],
      confirmation: null,
    });
    expect(await getTestStartReadiness(db, 'tenant-a', 'test-no-plan')).toEqual({
      ready: false,
      blockers: ['TEST_PLAN_NOT_FOUND', 'SAFETY_CHECKLIST_NOT_CONFIRMED'],
      confirmation: null,
    });

    const confirmed = await confirmTestSafetyChecklist(
      db,
      'tenant-a',
      trainer,
      'test-a',
      completeChecklist,
    );

    expect(confirmed).toMatchObject({
      tenantId: 'tenant-a',
      testId: 'test-a',
      checklistVersion: 'TEST_START_SAFETY_V1',
      confirmedByUserId: 'trainer-a',
    });
    expect(JSON.parse(confirmed.confirmationsJson)).toEqual(completeChecklist);
    expect((await getTestStartReadiness(db, 'tenant-a', 'test-a'))).toMatchObject({
      ready: true,
      blockers: [],
      confirmation: { id: confirmed.id },
    });
    expect(await getTestStartReadiness(db, 'tenant-b', 'test-a')).toEqual({
      ready: false,
      blockers: ['TEST_NOT_FOUND'],
      confirmation: null,
    });
    expect((await db.select().from(schema.auditEvents))[0]).toMatchObject({
      tenantId: 'tenant-a',
      action: 'test.safety_checklist_confirmed',
      entityId: confirmed.id,
    });
  });

  it('rejects incomplete, unauthorized, foreign, blocked and non-planned confirmations', async () => {
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-a',
      { ...completeChecklist, consentValid: false },
    )).rejects.toThrow('consentValid');
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', { userId: 'athlete-a', role: 'ATHLETE' }, 'test-a', completeChecklist,
    )).rejects.toThrow('Only trainers and tenant admins');
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', { userId: 'trainer-other', role: 'TRAINER' }, 'test-a', completeChecklist,
    )).rejects.toThrow('Only the conducting trainer');
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-b', completeChecklist,
    )).rejects.toThrow('Planned test not found');
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-no-plan', completeChecklist,
    )).rejects.toThrow('test plan snapshot is required');
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-blocked', completeChecklist,
    )).rejects.toThrow('blocked from diagnostic use');
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-running', completeChecklist,
    )).rejects.toThrow('only be confirmed for a planned test');

    expect(await db.select().from(schema.testSafetyChecklistConfirmations)).toHaveLength(0);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it('keeps the confirmation immutable and rechecks consent before start', async () => {
    const confirmed = await confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-a', completeChecklist,
    );
    await expect(confirmTestSafetyChecklist(
      db, 'tenant-a', trainer, 'test-a', completeChecklist,
    )).rejects.toThrow('already been confirmed');
    await expect(
      db.update(schema.testSafetyChecklistConfirmations)
        .set({ checklistVersion: 'tampered' })
        .where(eq(schema.testSafetyChecklistConfirmations.id, confirmed.id)),
    ).rejects.toThrow('Failed query: update');
    await expect(
      db.delete(schema.testSafetyChecklistConfirmations)
        .where(eq(schema.testSafetyChecklistConfirmations.id, confirmed.id)),
    ).rejects.toThrow('Failed query: delete');

    await db.update(schema.athletes)
      .set({ consentBlockedAt: '2026-07-30T10:00:00.000Z' })
      .where(eq(schema.athletes.id, 'athlete-a'));
    expect(await getTestStartReadiness(db, 'tenant-a', 'test-a')).toMatchObject({
      ready: false,
      blockers: ['ATHLETE_CONSENT_BLOCKED'],
      confirmation: { id: confirmed.id, checklistVersion: 'TEST_START_SAFETY_V1' },
    });
  });
});
