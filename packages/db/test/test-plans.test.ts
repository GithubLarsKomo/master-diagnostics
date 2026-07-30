import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  createTestPlanSnapshot,
  getTestPlanSnapshot,
} from '../src/services/test-plans';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-plans-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athlete_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE protocol_templates (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, device_type TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE protocol_template_versions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, template_id TEXT NOT NULL, version_number INTEGER NOT NULL, warmup_seconds INTEGER NOT NULL, readiness_seconds INTEGER NOT NULL, stage_seconds INTEGER NOT NULL, pause_seconds INTEGER NOT NULL, sample_target_seconds INTEGER NOT NULL, recovery_seconds INTEGER NOT NULL, default_max_stages INTEGER NOT NULL, partial_inclusion_percent INTEGER NOT NULL, config_json TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, current_version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_plan_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, protocol_version_id TEXT NOT NULL, athlete_snapshot_id TEXT NOT NULL, expected_lt2_watts INTEGER NOT NULL, start_watts INTEGER NOT NULL, increment_watts INTEGER NOT NULL, maximum_stages INTEGER NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_plan_snapshot_test_uq ON test_plan_snapshots (tenant_id, test_id)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TRIGGER test_plan_snapshots_immutable_update BEFORE UPDATE ON test_plan_snapshots BEGIN SELECT RAISE(ABORT, 'test plan snapshots are immutable'); END`,
    `CREATE TRIGGER test_plan_snapshots_immutable_delete BEFORE DELETE ON test_plan_snapshots BEGIN SELECT RAISE(ABORT, 'test plan snapshots are immutable'); END`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedPlanningContext(db: Database): Promise<void> {
  const now = '2026-07-30T09:00:00.000Z';
  await db.insert(schema.athletes).values([
    {
      id: 'athlete-a',
      tenantId: 'tenant-a',
      firstName: 'Petra',
      lastName: 'Muster',
      birthDate: '1992-04-18',
      referenceCategory: 'Masters A',
      heightCm: 174,
      currentWeightKgX100: 6850,
      primarySport: 'Rudern',
      primaryDiscipline: 'Einer',
      trainingStatus: 'leistungsorientiert',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'athlete-blocked',
      tenantId: 'tenant-a',
      firstName: 'Berta',
      lastName: 'Blockiert',
      birthDate: '1988-02-12',
      referenceCategory: 'Masters B',
      heightCm: 168,
      currentWeightKgX100: 6200,
      primarySport: 'Radsport',
      primaryDiscipline: 'Straße',
      trainingStatus: 'ambitioniert',
      consentBlockedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.coachAthleteAssignments).values({
    id: 'assignment-a',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    coachUserId: 'trainer-a',
    isPrimary: true,
    validFrom: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.protocolTemplates).values([
    {
      id: 'protocol-a',
      tenantId: 'tenant-a',
      deviceType: 'BIKEERG',
      name: 'BikeErg Masters',
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'protocol-b',
      tenantId: 'tenant-b',
      deviceType: 'ROWERG',
      name: 'Foreign RowErg',
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.protocolTemplateVersions).values([
    {
      id: 'protocol-version-a',
      tenantId: 'tenant-a',
      templateId: 'protocol-a',
      versionNumber: 1,
      warmupSeconds: 600,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 30,
      recoverySeconds: 300,
      defaultMaxStages: 8,
      partialInclusionPercent: 50,
      configJson: JSON.stringify({ deviceType: 'BIKEERG', source: 'tenant-version' }),
      createdByUserId: 'admin-a',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'protocol-version-b',
      tenantId: 'tenant-b',
      templateId: 'protocol-b',
      versionNumber: 1,
      warmupSeconds: 600,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 30,
      recoverySeconds: 300,
      defaultMaxStages: 8,
      partialInclusionPercent: 50,
      configJson: JSON.stringify({ deviceType: 'ROWERG' }),
      createdByUserId: 'admin-b',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

const trainer = { userId: 'trainer-a', role: 'TRAINER' };
const admin = { userId: 'admin-a', role: 'TENANT_ADMIN' };

describe('immutable test plan snapshots', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedPlanningContext(db);
  });

  it('atomically freezes the athlete, selected protocol version and LT2 plan', async () => {
    const created = await createTestPlanSnapshot(db, 'tenant-a', trainer, {
      athleteId: 'athlete-a',
      protocolVersionId: 'protocol-version-a',
      expectedLt2Watts: 350,
      stageCount: 8,
      startPowerWatts: 207,
      incrementWatts: 33,
      scheduledAt: '2026-08-01T10:00:00.000Z',
    });

    expect(created.test).toMatchObject({
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      deviceType: 'BIKEERG',
      status: 'PLANNED',
      conductingTrainerUserId: 'trainer-a',
    });
    expect(created.planSnapshot).toMatchObject({
      protocolVersionId: 'protocol-version-a',
      athleteSnapshotId: created.athleteSnapshot.id,
      startWatts: 205,
      incrementWatts: 35,
      maximumStages: 8,
    });

    const frozen = JSON.parse(created.planSnapshot.snapshotJson) as {
      plan: { warnings: Array<{ code: string }> };
    };
    expect(frozen).toMatchObject({
      schemaVersion: 1,
      athlete: { id: 'athlete-a', currentWeightKgX100: 6850 },
      protocolTemplate: { id: 'protocol-a', name: 'BikeErg Masters' },
      protocolVersion: { id: 'protocol-version-a', versionNumber: 1 },
      plan: {
        algorithmVersion: 'LT2_PLAN_V1',
        expectedLt2Watts: 350,
        powersWatts: [205, 240, 275, 310, 345, 380, 415, 450],
        trainerOverrides: {
          stageCount: 8,
          startPowerWatts: 207,
          incrementWatts: 33,
        },
      },
    });
    expect(frozen.plan.warnings.map((warning) => warning.code)).toEqual([
      'START_POWER_ROUNDED',
      'INCREMENT_ROUNDED',
      'LT2_TARGET_MISMATCH',
    ]);
    expect(await db.select().from(schema.athleteSnapshots)).toHaveLength(1);
    expect((await db.select().from(schema.auditEvents))[0]).toMatchObject({
      tenantId: 'tenant-a',
      action: 'test.plan_snapshot_created',
      entityId: created.planSnapshot.id,
    });
    expect(await getTestPlanSnapshot(db, 'tenant-a', created.test.id)).toMatchObject({
      id: created.planSnapshot.id,
    });
    expect(await getTestPlanSnapshot(db, 'tenant-b', created.test.id)).toBeNull();
  });

  it('rejects unauthorized, cross-tenant and blocked planning without partial writes', async () => {
    await expect(
      createTestPlanSnapshot(db, 'tenant-a', { userId: 'viewer-a', role: 'VIEWER' }, {
        athleteId: 'athlete-a',
        protocolVersionId: 'protocol-version-a',
        expectedLt2Watts: 350,
      }),
    ).rejects.toThrow('Only trainers and tenant admins');
    await expect(
      createTestPlanSnapshot(db, 'tenant-a', { userId: 'trainer-other', role: 'TRAINER' }, {
        athleteId: 'athlete-a',
        protocolVersionId: 'protocol-version-a',
        expectedLt2Watts: 350,
      }),
    ).rejects.toThrow('Trainer is not assigned');
    await expect(
      createTestPlanSnapshot(db, 'tenant-a', admin, {
        athleteId: 'athlete-a',
        protocolVersionId: 'protocol-version-b',
        expectedLt2Watts: 350,
      }),
    ).rejects.toThrow('Active protocol template version not found');
    await expect(
      createTestPlanSnapshot(db, 'tenant-a', admin, {
        athleteId: 'athlete-blocked',
        protocolVersionId: 'protocol-version-a',
        expectedLt2Watts: 350,
      }),
    ).rejects.toThrow('blocked from diagnostic use');

    expect(await db.select().from(schema.tests)).toHaveLength(0);
    expect(await db.select().from(schema.testPlanSnapshots)).toHaveLength(0);
    expect(await db.select().from(schema.athleteSnapshots)).toHaveLength(0);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it('enforces immutability at the database boundary', async () => {
    const created = await createTestPlanSnapshot(db, 'tenant-a', admin, {
      athleteId: 'athlete-a',
      protocolVersionId: 'protocol-version-a',
      expectedLt2Watts: 350,
    });

    await expect(
      db.update(schema.testPlanSnapshots)
        .set({ startWatts: 999 })
        .where(eq(schema.testPlanSnapshots.id, created.planSnapshot.id)),
    ).rejects.toThrow('test plan snapshots are immutable');
    await expect(
      db.delete(schema.testPlanSnapshots)
        .where(eq(schema.testPlanSnapshots.id, created.planSnapshot.id)),
    ).rejects.toThrow('test plan snapshots are immutable');

    expect(await getTestPlanSnapshot(db, 'tenant-a', created.test.id)).toMatchObject({
      startWatts: 210,
      incrementWatts: 35,
      maximumStages: 7,
    });
  });
});
