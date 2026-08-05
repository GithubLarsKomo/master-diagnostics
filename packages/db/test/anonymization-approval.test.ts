import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  approveAthleteAnonymization,
  BACKUP_PRIVACY_POLICY_VERSION,
  createDatabaseFromConfig,
  migrateDatabase,
  NOTIFICATION_PRIVACY_POLICY_VERSION,
  validateAthleteAnonymizationApproval,
  type Database,
  type GlobalPrivacyCapabilities,
} from '../src';
import * as schema from '../src';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-anonymization-approval-${crypto.randomUUID()}.db`;
  const db = createDatabaseFromConfig({ url: `file:${databasePath}` });
  await migrateDatabase(db, './migrations');
  return db;
}

const createdAt = '2019-01-01T00:00:00.000Z';
const deletedAt = '2025-01-03T00:00:00.000Z';
const adminActor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};
const coachActor = {
  userId: 'coach-a', role: 'COACH', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'coach-session-a',
};

async function seedReadyAthlete(db: Database) {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 1, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values([
    {
      id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
      createdAt, updatedAt: createdAt,
    },
    {
      id: 'coach-a', email: 'coach@example.test', displayName: 'Coach', preferredLocale: 'de',
      createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: deletedAt, deletedAt, createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Petra requested deletion', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Approved for Petra', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
}

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
      approvalVersion: 1, policyVersion: '1.6.0', approvedByUserId: 'admin-a',
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

    const [beforeMutation] = await db.select().from(schema.athleteAnonymizationApprovals)
      .where(eq(schema.athleteAnonymizationApprovals.id, approval.id));
    await expect(db.update(schema.athleteAnonymizationApprovals)
      .set({ policyVersion: 'tampered' })
      .where(eq(schema.athleteAnonymizationApprovals.id, approval.id)))
      .rejects.toThrow(/immutable/i);
    const [afterMutation] = await db.select().from(schema.athleteAnonymizationApprovals)
      .where(eq(schema.athleteAnonymizationApprovals.id, approval.id));
    expect(afterMutation).toEqual(beforeMutation);
  });

  it('invalidates an approval when the current scope changes', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );

    await db.insert(schema.athleteGuardians).values({
      id: 'guardian-a', tenantId: 'tenant-a', athleteId: 'athlete-a', fullName: 'Erika Muster',
      relationship: 'MOTHER', email: null, phone: null,
      authorityConfirmedAt: '2020-01-01T00:00:00.000Z', validUntil: null, revokedAt: null,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
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
    expect(validation.blockers).toContain('CAPABILITY_FINGERPRINT_CHANGED');
  });

  it('rejects non-admin approval and incomplete global capabilities', async () => {
    const db = await createTestDatabase();
    await seedReadyAthlete(db);

    await expect(approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', coachActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/tenant admin/i);

    const incompleteCapabilities: GlobalPrivacyCapabilities = {
      backup: { state: 'ENABLED', policyVersion: BACKUP_PRIVACY_POLICY_VERSION },
      notifications: { state: 'DISABLED' },
    };
    await expect(approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, incompleteCapabilities, '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/global privacy/i);
  });
});