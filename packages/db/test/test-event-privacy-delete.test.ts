import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { approveAthleteAnonymization } from '../src/services/anonymization-approval';
import { prepareAthleteAnonymizationExecution } from '../src/services/anonymization-execution';
import type { GlobalPrivacyCapabilities } from '../src/services/global-privacy-policy';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-event-privacy-delete-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function seed(db: Database) {
  const createdAt = '2019-01-01T00:00:00.000Z';
  const deletedAt = '2025-01-03T00:00:00.000Z';
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 1, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: deletedAt, deletedAt, createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.tests).values({
    id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
    conductingTrainerUserId: 'trainer-a', startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: '2020-01-01T11:00:00.000Z', releasedAt: '2020-01-01T11:00:00.000Z', currentVersion: 1,
    createdAt: '2020-01-01T09:00:00.000Z', updatedAt: '2020-01-01T11:00:00.000Z',
  });
  await db.insert(schema.testSafetyChecklistConfirmations).values({
    id: 'safety-a', tenantId: 'tenant-a', testId: 'test-a', checklistVersion: '1',
    confirmationsJson: '{}', confirmedByUserId: 'admin-a', confirmedAt: '2020-01-01T09:55:00.000Z',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testTerminationEvents).values({
    id: 'termination-a', tenantId: 'tenant-a', testId: 'test-a', reason: 'REGULAR_EXHAUSTION',
    notes: null, endedByUserId: 'admin-a', endedAt: '2020-01-01T11:00:00.000Z',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Betroffenenrecht', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Freigegeben', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
}

const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};
const capabilities: GlobalPrivacyCapabilities = {
  backup: { state: 'DISABLED' }, notifications: { state: 'DISABLED' },
};

describe('immutable test event privacy deletion gates', () => {
  it('allows safety and termination DELETE only for a staged bound execution', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', actor, capabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, actor, capabilities, '2026-08-05T13:05:00.000Z',
    );

    await expect(db.delete(schema.testSafetyChecklistConfirmations)
      .where(eq(schema.testSafetyChecklistConfirmations.id, 'safety-a'))).rejects.toThrow();
    await expect(db.delete(schema.testTerminationEvents)
      .where(eq(schema.testTerminationEvents.id, 'termination-a'))).rejects.toThrow();

    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'ARTIFACTS_STAGED', artifactsStagedAt: '2026-08-05T13:06:00.000Z',
      updatedAt: '2026-08-05T13:06:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));

    await db.delete(schema.testSafetyChecklistConfirmations)
      .where(eq(schema.testSafetyChecklistConfirmations.id, 'safety-a'));
    await db.delete(schema.testTerminationEvents)
      .where(eq(schema.testTerminationEvents.id, 'termination-a'));
    expect(await db.select().from(schema.testSafetyChecklistConfirmations)).toEqual([]);
    expect(await db.select().from(schema.testTerminationEvents)).toEqual([]);
  });

  it('keeps UPDATE immutable even while the execution is staged', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', actor, capabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, actor, capabilities, '2026-08-05T13:05:00.000Z',
    );
    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'ARTIFACTS_STAGED', artifactsStagedAt: '2026-08-05T13:06:00.000Z',
      updatedAt: '2026-08-05T13:06:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));

    await expect(db.update(schema.testSafetyChecklistConfirmations)
      .set({ updatedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(schema.testSafetyChecklistConfirmations.id, 'safety-a'))).rejects.toThrow();
    await expect(db.update(schema.testTerminationEvents)
      .set({ updatedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(schema.testTerminationEvents.id, 'termination-a'))).rejects.toThrow();
  });
});
