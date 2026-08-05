import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { cleanupUnavailableAthleteDataSubjectDeliveryPackages } from '../src/services/data-subject-delivery-cleanup';
import { listAthleteDataSubjectDeliveryCleanupCandidates } from '../src/services/data-subject-delivery-packages';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-subject-cleanup-${crypto.randomUUID()}.db` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const base = '2026-08-05T20:00:00.000Z';
const now = '2026-08-05T22:00:00.000Z';

async function seedBase(db: Database) {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10, createdAt: base, updatedAt: base,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
    createdAt: base, updatedAt: base,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: null, deletedAt: null, createdAt: base, updatedAt: base,
  });
  await db.insert(schema.athleteDataSubjectDeliveryApprovals).values({
    id: 'delivery-approval-a', tenantId: 'tenant-a', athleteId: 'athlete-a', approvalVersion: 1,
    sourceSchemaVersion: 'masters-data-subject-export-v1', deliveryPolicyVersion: 'masters-data-subject-delivery-v1',
    assessedAt: base, sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    decisionsFingerprint: `sha256:${'b'.repeat(64)}`, reviewDecisionsJson: '[]',
    approvedByUserId: 'admin-a', approvedAt: base, createdAt: base, updatedAt: base,
  });
}

async function insertPackage(
  db: Database,
  id: string,
  expiresAt: string,
  downloadedAt: string | null,
  marker: string,
) {
  await db.insert(schema.athleteDataSubjectDeliveryPackages).values({
    id,
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    approvalId: 'delivery-approval-a',
    packageVersion: 1,
    manifestFingerprint: `sha256:${marker.repeat(64)}`,
    tokenHash: `sha256:${marker.toUpperCase().repeat(64)}`,
    storageReference: `${id}.mdse`,
    packageSha256: `sha256:${marker.repeat(64)}`,
    createdByUserId: 'admin-a',
    expiresAt,
    downloadedAt,
    createdAt: base,
    updatedAt: downloadedAt ?? base,
  });
}

async function seedPreparingAnonymization(db: Database) {
  const deletedAt = '2025-01-03T00:00:00.000Z';
  await db.update(schema.athletes).set({ consentBlockedAt: deletedAt, deletedAt, updatedAt: deletedAt });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'request', requestedAt: '2025-01-01T00:00:00.000Z', decidedAt: '2025-01-02T00:00:00.000Z',
    decisionReason: 'approved', completedAt: deletedAt, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
  await db.insert(schema.athleteAnonymizationApprovals).values({
    id: 'anon-approval-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deletionRequestId: 'deletion-a',
    approvalVersion: 1, policyVersion: '1.6.0', assessedAt: base,
    scopeFingerprint: `sha256:${'c'.repeat(64)}`, capabilityFingerprint: `sha256:${'d'.repeat(64)}`,
    approvedByUserId: 'admin-a', approvedAt: base, createdAt: base, updatedAt: base,
  });
  await db.insert(schema.athleteAnonymizationExecutions).values({
    id: 'execution-cleanup-race', tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: 'anon-approval-a',
    executionVersion: 1, status: 'PREPARING', preparedByUserId: 'admin-a', preparedAt: base,
    artifactsStagedAt: null, dbCommittedAt: null, completedAt: null, abortedAt: null,
    createdAt: base, updatedAt: base,
  });
}

describe('data subject delivery package lifecycle cleanup', () => {
  it('removes consumed and expired packages but keeps a still-deliverable package', async () => {
    const db = await createTestDatabase();
    await seedBase(db);
    await insertPackage(db, '11111111-1111-1111-1111-111111111111', '2026-08-05T21:00:00.000Z', null, '1');
    await insertPackage(db, '22222222-2222-2222-2222-222222222222', '2026-08-06T21:00:00.000Z', '2026-08-05T21:30:00.000Z', '2');
    await insertPackage(db, '33333333-3333-3333-3333-333333333333', '2026-08-06T21:00:00.000Z', null, '3');

    const candidates = await listAthleteDataSubjectDeliveryCleanupCandidates(db, now);
    expect(candidates.map((row) => row.id)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
    const serializedCandidates = JSON.stringify(candidates);
    expect(serializedCandidates).not.toContain('tokenHash');
    expect(serializedCandidates).not.toContain('manifestFingerprint');
    expect(serializedCandidates).not.toContain('packageSha256');

    const remove = vi.fn().mockResolvedValue(undefined);
    const summary = await cleanupUnavailableAthleteDataSubjectDeliveryPackages(db, { remove }, now);

    expect(summary).toEqual({
      assessedAt: now, candidateCount: 2, removedCount: 2, skippedActiveAnonymizationCount: 0,
    });
    expect(remove.mock.calls.map(([reference]) => reference)).toEqual([
      '11111111-1111-1111-1111-111111111111.mdse',
      '22222222-2222-2222-2222-222222222222.mdse',
    ]);
    const remaining = await db.select().from(schema.athleteDataSubjectDeliveryPackages);
    expect(remaining.map((row) => row.id)).toEqual(['33333333-3333-3333-3333-333333333333']);
  });

  it('keeps metadata when physical artifact removal fails', async () => {
    const db = await createTestDatabase();
    await seedBase(db);
    await insertPackage(db, '44444444-4444-4444-4444-444444444444', '2026-08-05T21:00:00.000Z', null, '4');

    await expect(cleanupUnavailableAthleteDataSubjectDeliveryPackages(db, {
      remove: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    }, now)).rejects.toThrow(/storage unavailable/i);

    expect(await db.select().from(schema.athleteDataSubjectDeliveryPackages)).toHaveLength(1);
  });

  it('skips candidates while the tenant owns a PREPARING anonymization execution', async () => {
    const db = await createTestDatabase();
    await seedBase(db);
    await insertPackage(db, '55555555-5555-5555-5555-555555555555', '2026-08-05T21:00:00.000Z', null, '5');
    await seedPreparingAnonymization(db);
    const remove = vi.fn();

    const summary = await cleanupUnavailableAthleteDataSubjectDeliveryPackages(db, { remove }, now);

    expect(summary).toEqual({
      assessedAt: now, candidateCount: 1, removedCount: 0, skippedActiveAnonymizationCount: 1,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await db.select().from(schema.athleteDataSubjectDeliveryPackages)).toHaveLength(1);
  });
});
