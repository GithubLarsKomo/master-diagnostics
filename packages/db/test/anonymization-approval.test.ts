import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  approveAthleteAnonymization,
  validateAthleteAnonymizationApproval,
} from '../src/services/anonymization-approval';
import {
  BACKUP_PRIVACY_POLICY_VERSION,
  NOTIFICATION_PRIVACY_POLICY_VERSION,
  type GlobalPrivacyCapabilities,
} from '../src/services/global-privacy-policy';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-anonymization-approval-${crypto.randomUUID()}.db`;
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

const enabledCapabilities: GlobalPrivacyCapabilities = {
  backup: {
    state: 'ENABLED', policyVersion: BACKUP_PRIVACY_POLICY_VERSION,
    encryptedAtRest: true, boundedRetentionConfigured: true, restorePrivacyReconciliation: true,
  },
  notifications: {
    state: 'ENABLED', policyVersion: NOTIFICATION_PRIVACY_POLICY_VERSION,
    subjectScopedPayloadContract: true, directIdentifiersForbidden: true, subjectCleanupSupported: true,
  },
};

describe('athlete anonymization admin approval', () => {
  it('stores an immutable PII-free approval bound to the reviewed scope and capabilities', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);

    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );

    expect(approval).toMatchObject({
      tenantId: 'tenant-a', athleteId: 'athlete-a', deletionRequestId: 'deletion-a',
      approvalVersion: 1, policyVersion: '1.4.0', approvedByUserId: 'admin-a',
    });
    expect(approval.scopeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(approval.capabilityFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const validation = await validateAthleteAnonymizationApproval(
      db, 'tenant-a', 'athlete-a', approval.id, disabledCapabilities, '2026-08-05T13:05:00.000Z',
    );
    expect(validation).toMatchObject({ validForExecutionPreparation: true, blockers: [] });

    const auditRows = await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'athlete.anonymization_approved'));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.afterJson).toContain(approval.scopeFingerprint);
    expect(auditRows[0]?.afterJson).not.toContain('Petra');
    expect(auditRows[0]?.afterJson).not.toContain('Muster');

    await expect(db.update(schema.athleteAnonymizationApprovals)
      .set({ approvedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(schema.athleteAnonymizationApprovals.id, approval.id)))
      .rejects.toThrow(/immutable/i);
    await expect(db.delete(schema.athleteAnonymizationApprovals)
      .where(eq(schema.athleteAnonymizationApprovals.id, approval.id)))
      .rejects.toThrow(/immutable/i);
  });

  it('invalidates an approval when the current scope changes', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );

    await db.insert(schema.athleteGuardians).values({
      id: 'guardian-late', tenantId: 'tenant-a', athleteId: 'athlete-a', fullName: 'Legacy Guardian',
      relationship: 'parent', email: null, phone: null, authorityConfirmedAt: '2020-01-01T00:00:00.000Z',
      validUntil: null, revokedAt: '2025-01-03T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2025-01-03T00:00:00.000Z',
    });

    const validation = await validateAthleteAnonymizationApproval(
      db, 'tenant-a', 'athlete-a', approval.id, disabledCapabilities, '2026-08-05T13:05:00.000Z',
    );
    expect(validation.validForExecutionPreparation).toBe(false);
    expect(validation.blockers).toContain('SCOPE_FINGERPRINT_CHANGED');
  });

  it('invalidates an approval when the attested capability state changes', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );

    const validation = await validateAthleteAnonymizationApproval(
      db, 'tenant-a', 'athlete-a', approval.id, enabledCapabilities, '2026-08-05T13:05:00.000Z',
    );
    expect(validation.validForExecutionPreparation).toBe(false);
    expect(validation.blockers).toContain('GLOBAL_PRIVACY_CAPABILITY_FINGERPRINT_CHANGED');
  });

  it('rejects non-admin approval and incomplete global capabilities', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    await expect(approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', { ...adminActor, role: 'TRAINER' }, disabledCapabilities,
      '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/Tenant admin/i);

    await expect(approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor,
      { backup: { state: 'ENABLED' }, notifications: { state: 'DISABLED' } },
      '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/Global privacy capabilities/i);
  });
});
