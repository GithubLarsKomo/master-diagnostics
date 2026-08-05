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
  const databasePath = `/tmp/masters-snapshot-privacy-delete-${crypto.randomUUID()}.db`;
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
  await db.insert(schema.athleteSnapshots).values({
    id: 'athlete-snapshot-a', tenantId: 'tenant-a', athleteId: 'athlete-a',
    snapshotJson: '{"firstName":"Petra","lastName":"Muster"}', version: 1,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.protocolTemplates).values({
    id: 'protocol-a', tenantId: 'tenant-a', deviceType: 'ROWERG', name: 'Protocol A', active: true,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.protocolTemplateVersions).values({
    id: 'protocol-version-a', tenantId: 'tenant-a', templateId: 'protocol-a', versionNumber: 1,
    createdByUserId: 'admin-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tests).values({
    id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
    conductingTrainerUserId: 'trainer-a', startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: '2020-01-01T11:00:00.000Z', releasedAt: '2020-01-01T11:00:00.000Z', currentVersion: 1,
    createdAt: '2020-01-01T09:00:00.000Z', updatedAt: '2020-01-01T11:00:00.000Z',
  });
  await db.insert(schema.testPlanSnapshots).values({
    id: 'plan-a', tenantId: 'tenant-a', testId: 'test-a', protocolVersionId: 'protocol-version-a',
    athleteSnapshotId: 'athlete-snapshot-a', expectedLt2Watts: 300, startWatts: 180,
    incrementWatts: 30, maximumStages: 8, snapshotJson: '{}', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.diagnosticResultSnapshots).values({
    id: 'diagnostic-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    schemaVersion: '1', canonicalization: 'diagnostic-json-v1',
    resultHash: `sha256:${'a'.repeat(64)}`, resultJson: '{}', createdAt, updatedAt: createdAt,
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

describe('immutable snapshot privacy deletion gates', () => {
  it('keeps test-plan and diagnostic snapshots immutable until a bound execution is staged', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', actor, capabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, actor, capabilities, '2026-08-05T13:05:00.000Z',
    );

    await expect(db.delete(schema.testPlanSnapshots)
      .where(eq(schema.testPlanSnapshots.id, 'plan-a'))).rejects.toThrow();
    await expect(db.delete(schema.diagnosticResultSnapshots)
      .where(eq(schema.diagnosticResultSnapshots.id, 'diagnostic-a'))).rejects.toThrow();

    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'ARTIFACTS_STAGED', artifactsStagedAt: '2026-08-05T13:06:00.000Z',
      updatedAt: '2026-08-05T13:06:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));

    await db.delete(schema.testPlanSnapshots).where(eq(schema.testPlanSnapshots.id, 'plan-a'));
    await db.delete(schema.diagnosticResultSnapshots).where(eq(schema.diagnosticResultSnapshots.id, 'diagnostic-a'));

    expect(await db.select().from(schema.testPlanSnapshots)).toEqual([]);
    expect(await db.select().from(schema.diagnosticResultSnapshots)).toEqual([]);
  });

  it('does not weaken immutable UPDATE protection', async () => {
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

    await expect(db.update(schema.testPlanSnapshots).set({ updatedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(schema.testPlanSnapshots.id, 'plan-a'))).rejects.toThrow();
    await expect(db.update(schema.diagnosticResultSnapshots).set({ updatedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(schema.diagnosticResultSnapshots.id, 'diagnostic-a'))).rejects.toThrow();
  });
});
