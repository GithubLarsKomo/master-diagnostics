import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { approveAthleteAnonymization } from '../src/services/anonymization-approval';
import {
  getAthleteAnonymizationExecution,
  listAthleteAnonymizationExecutionArtifacts,
  prepareAthleteAnonymizationExecution,
} from '../src/services/anonymization-execution';
import type { GlobalPrivacyCapabilities } from '../src/services/global-privacy-policy';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-anonymization-execution-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function seedReadyAthlete(db: Database) {
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
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Betroffenenrecht', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Freigegeben', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
}

async function seedExternalArtifactReferences(db: Database) {
  const createdAt = '2020-01-01T12:00:00.000Z';
  await db.insert(schema.interpretations).values({
    id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    lt1Json: '{}', lt2Json: '{}', rationale: null, status: 'RELEASED',
    releasedAt: createdAt, releasedByUserId: 'trainer-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.reportVersions).values({
    id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a',
    versionNumber: 1, locale: 'de', contentHash: `sha256:${'a'.repeat(64)}`,
    storageReference: 'tenant-a/test-a/de/report.pdf', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tenantExportPackages).values({
    id: 'export-a', tenantId: 'tenant-a', tokenHash: `sha256:${'b'.repeat(64)}`,
    storageReference: '01234567-89ab-cdef-0123-456789abcdef.mde',
    packageSha256: `sha256:${'c'.repeat(64)}`, createdByUserId: 'admin-a',
    expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
    createdAt, updatedAt: createdAt,
  });
}

const adminActor = {
  userId: 'admin-a',
  role: 'TENANT_ADMIN',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};

const disabledCapabilities: GlobalPrivacyCapabilities = {
  backup: { state: 'DISABLED' },
  notifications: { state: 'DISABLED' },
};

describe('athlete anonymization execution contract', () => {
  it('prepares exactly one PII-free durable execution and persists its artifact manifest', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    await seedExternalArtifactReferences(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );

    const first = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, adminActor, disabledCapabilities,
      '2026-08-05T13:10:00.000Z',
    );
    const second = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, adminActor, disabledCapabilities,
      '2026-08-05T13:11:00.000Z',
    );

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id,
      executionVersion: 1, status: 'PREPARING', preparedByUserId: 'admin-a',
      artifactsStagedAt: null, dbCommittedAt: null, completedAt: null, abortedAt: null,
    });

    const manifest = await listAthleteAnonymizationExecutionArtifacts(db, 'tenant-a', first.id);
    expect(manifest.map(({ kind, storageReference }) => ({ kind, storageReference }))).toEqual([
      { kind: 'REPORT', storageReference: 'tenant-a/test-a/de/report.pdf' },
      { kind: 'TENANT_EXPORT', storageReference: '01234567-89ab-cdef-0123-456789abcdef.mde' },
    ]);

    await db.delete(schema.reportVersions).where(eq(schema.reportVersions.id, 'report-a'));
    await db.delete(schema.tenantExportPackages).where(eq(schema.tenantExportPackages.id, 'export-a'));
    expect((await listAthleteAnonymizationExecutionArtifacts(db, 'tenant-a', first.id))).toEqual(manifest);

    await expect(db.update(schema.athleteAnonymizationExecutionArtifacts).set({
      storageReference: 'changed.pdf', updatedAt: '2099-01-01T00:00:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutionArtifacts.executionId, first.id))).rejects.toThrow();
    await expect(db.delete(schema.athleteAnonymizationExecutionArtifacts)
      .where(eq(schema.athleteAnonymizationExecutionArtifacts.executionId, first.id))).rejects.toThrow();

    const auditRows = await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'athlete.anonymization_execution_prepared'));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ entityId: first.id });
    expect(auditRows[0]?.afterJson).toContain(approval.id);
    expect(auditRows[0]?.afterJson).toContain('"reportArtifactCount":1');
    expect(auditRows[0]?.afterJson).toContain('"tenantExportArtifactCount":1');
    expect(auditRows[0]?.afterJson).not.toContain('Petra');
    expect(auditRows[0]?.afterJson).not.toContain('Muster');
  });

  it('enforces monotonic execution phases and immutable execution evidence in SQLite', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, adminActor, disabledCapabilities,
      '2026-08-05T13:10:00.000Z',
    );

    await expect(db.update(schema.athleteAnonymizationExecutions).set({
      status: 'DB_COMMITTED', dbCommittedAt: '2026-08-05T13:12:00.000Z',
      updatedAt: '2026-08-05T13:12:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id))).rejects.toThrow();

    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'ARTIFACTS_STAGED', artifactsStagedAt: '2026-08-05T13:12:00.000Z',
      updatedAt: '2026-08-05T13:12:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));
    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'DB_COMMITTED', dbCommittedAt: '2026-08-05T13:13:00.000Z',
      updatedAt: '2026-08-05T13:13:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));
    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'COMPLETED', completedAt: '2026-08-05T13:14:00.000Z',
      updatedAt: '2026-08-05T13:14:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));

    const stored = await getAthleteAnonymizationExecution(db, 'tenant-a', 'athlete-a', execution.id);
    expect(stored).toMatchObject({
      status: 'COMPLETED',
      artifactsStagedAt: '2026-08-05T13:12:00.000Z',
      dbCommittedAt: '2026-08-05T13:13:00.000Z',
      completedAt: '2026-08-05T13:14:00.000Z',
      abortedAt: null,
    });

    await expect(db.update(schema.athleteAnonymizationExecutions).set({
      preparedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id))).rejects.toThrow();
    await expect(db.delete(schema.athleteAnonymizationExecutions)
      .where(eq(schema.athleteAnonymizationExecutions.id, execution.id))).rejects.toThrow();
  });

  it('allows abort only before the database commit boundary', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, adminActor, disabledCapabilities,
      '2026-08-05T13:10:00.000Z',
    );

    await db.update(schema.athleteAnonymizationExecutions).set({
      status: 'ABORTED', abortedAt: '2026-08-05T13:11:00.000Z',
      updatedAt: '2026-08-05T13:11:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));

    await expect(db.update(schema.athleteAnonymizationExecutions).set({
      status: 'COMPLETED', completedAt: '2026-08-05T13:12:00.000Z',
      updatedAt: '2026-08-05T13:12:00.000Z',
    }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id))).rejects.toThrow();
  });
});
