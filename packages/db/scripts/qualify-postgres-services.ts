import assert from 'node:assert/strict';
import {
  athleteSnapshots,
  coachAthleteAssignments,
  protocolTemplates,
  protocolTemplateVersions,
  testPlanSnapshots,
  tests,
  users,
} from '../src/schema';
import { createPostgresDatabase } from '../src/postgres/client';
import { createAthlete, getAthlete, listAthletes, updateAthlete } from '../src/services/athletes';
import { acquireTestLock, releaseTestLock } from '../src/services/test-locks';
import { syncTestMeasurement } from '../src/services/test-measurement-sync';

const tenantA = 'pg-qualification-tenant-a';
const tenantB = 'pg-qualification-tenant-b';
const trainerId = 'pg-qualification-trainer-a';
const now = '2026-08-24T10:00:00.000Z';
const actor = {
  userId: trainerId,
  role: 'TRAINER',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'pg-qualification-session',
};

const concrete = createPostgresDatabase();
const { db, sql } = concrete;

try {
  await sql.unsafe(`
    INSERT INTO tenants(id, slug, name, deployment_mode, timezone, locale, retention_years, created_at, updated_at)
    VALUES
      ('${tenantA}', '${tenantA}', 'PG Qualification A', 'CLUB', 'Europe/Berlin', 'de', 10, '${now}', '${now}'),
      ('${tenantB}', '${tenantB}', 'PG Qualification B', 'CLUB', 'Europe/Berlin', 'de', 10, '${now}', '${now}')
    ON CONFLICT (id) DO NOTHING
  `);

  await db.insert(users).values({
    id: trainerId,
    email: 'pg-qualification@example.invalid',
    displayName: 'PG Qualification Trainer',
    preferredLocale: 'de',
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const athlete = await createAthlete(db, tenantA, actor, {
    firstName: 'Postgres',
    lastName: 'Athlete',
    birthDate: '1990-01-02',
    referenceCategory: 'Masters A',
    heightCm: 180,
    currentWeightKgX100: 7500,
    primarySport: 'Rudern',
    primaryDiscipline: 'Einer',
    trainingStatus: 'leistungsorientiert',
  });
  assert.ok(athlete);
  assert.equal((await listAthletes(db, tenantA)).length, 1);
  assert.equal((await listAthletes(db, tenantB)).length, 0);
  assert.equal(await getAthlete(db, tenantB, athlete.id), null);
  await assert.rejects(
    updateAthlete(db, tenantB, athlete.id, actor, {
      firstName: 'Wrong',
      lastName: 'Tenant',
      birthDate: '1990-01-02',
      referenceCategory: 'Masters A',
      heightCm: 180,
      currentWeightKgX100: 7600,
      primarySport: 'Rudern',
      primaryDiscipline: 'Einer',
      trainingStatus: 'leistungsorientiert',
    }),
    /Athlete not found/,
  );

  const athleteSnapshotId = 'pg-qualification-athlete-snapshot';
  const templateId = 'pg-qualification-template';
  const protocolVersionId = 'pg-qualification-protocol-version';
  const testId = 'pg-qualification-test';

  await db.insert(athleteSnapshots).values({
    id: athleteSnapshotId,
    tenantId: tenantA,
    athleteId: athlete.id,
    snapshotJson: JSON.stringify({ athleteId: athlete.id }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(protocolTemplates).values({
    id: templateId,
    tenantId: tenantA,
    deviceType: 'BIKEERG',
    name: 'PG Qualification',
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(protocolTemplateVersions).values({
    id: protocolVersionId,
    tenantId: tenantA,
    templateId,
    versionNumber: 1,
    warmupSeconds: 60,
    readinessSeconds: 30,
    stageSeconds: 240,
    pauseSeconds: 60,
    sampleTargetSeconds: 30,
    recoverySeconds: 300,
    defaultMaxStages: 1,
    partialInclusionPercent: 50,
    configJson: JSON.stringify({ audioWarningSeconds: [30, 10, 3] }),
    createdByUserId: trainerId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(tests).values({
    id: testId,
    tenantId: tenantA,
    athleteId: athlete.id,
    deviceType: 'BIKEERG',
    status: 'IN_PROGRESS',
    conductingTrainerUserId: trainerId,
    startedAt: now,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(testPlanSnapshots).values({
    id: 'pg-qualification-plan-snapshot',
    tenantId: tenantA,
    testId,
    protocolVersionId,
    athleteSnapshotId,
    expectedLt2Watts: 200,
    startWatts: 120,
    incrementWatts: 20,
    maximumStages: 1,
    snapshotJson: JSON.stringify({
      protocolVersion: {
        warmupSeconds: 60,
        readinessSeconds: 30,
        stageSeconds: 240,
        pauseSeconds: 60,
        sampleTargetSeconds: 30,
        recoverySeconds: 300,
        configJson: JSON.stringify({ audioWarningSeconds: [30, 10, 3] }),
      },
      plan: { powersWatts: [120] },
    }),
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(coachAthleteAssignments).values({
    id: 'pg-qualification-assignment',
    tenantId: tenantA,
    athleteId: athlete.id,
    coachUserId: trainerId,
    isPrimary: true,
    validFrom: now,
    createdAt: now,
    updatedAt: now,
  });

  const acquired = await acquireTestLock(
    db,
    tenantA,
    actor,
    testId,
    new Date('2026-08-24T10:01:00.000Z'),
  );
  assert.equal(acquired.status, 'ACQUIRED');
  if (acquired.status !== 'ACQUIRED') throw new Error('PostgreSQL test lock was not acquired');

  const competing = await acquireTestLock(
    db,
    tenantA,
    actor,
    testId,
    new Date('2026-08-24T10:01:10.000Z'),
  );
  assert.equal(competing.status, 'LOCKED');

  const operation = {
    operationId: 'pg-qualification-operation-1',
    testId,
    entityId: 'REST',
    expectedVersion: 0,
    occurredAt: '2026-08-24T10:01:15.000Z',
    operationType: 'TEST_MEASUREMENT_UPSERT' as const,
    schemaVersion: '1' as const,
    payload: {
      target: { kind: 'REST' as const, stageNumber: null },
      lactateValueX100: 120,
      lactateQualifier: 'EXACT' as const,
      heartRate: 80,
      measuredAt: '2026-08-24T10:01:14.000Z',
    },
  };

  const first = await syncTestMeasurement(db, tenantA, actor, operation, acquired.token);
  assert.deepEqual(first, { status: 'APPLIED', newVersion: 1 });
  const replay = await syncTestMeasurement(db, tenantA, actor, operation, acquired.token);
  assert.deepEqual(replay, first);

  const stale = await syncTestMeasurement(db, tenantA, actor, {
    ...operation,
    operationId: 'pg-qualification-operation-2',
  }, acquired.token);
  assert.equal(stale.status, 'CONFLICT');
  if (stale.status !== 'CONFLICT') throw new Error('Expected optimistic version conflict');
  assert.equal(stale.serverVersion, 1);

  await assert.rejects(
    syncTestMeasurement(db, tenantB, actor, {
      ...operation,
      operationId: 'pg-qualification-operation-cross-tenant',
    }, acquired.token),
    /Test timer context not found/,
  );

  await releaseTestLock(db, tenantA, actor, testId, acquired.token);

  console.log(JSON.stringify({
    engine: 'postgres',
    tenantIsolation: 'passed',
    lockLease: 'passed',
    idempotentReplay: 'passed',
    optimisticVersionConflict: 'passed',
  }));
} finally {
  await concrete.close();
}
