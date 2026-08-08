import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { AUDIT_PRIVACY_REDACTED_TEXT } from '../src/services/audit-privacy-redaction';
import { athleteTombstoneV1 } from '../src/services/anonymization-tombstone';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';
import { assessRestorePrivacyReplayDatabase } from '../src/services/restore-privacy-replay-assessment';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-restore-replay-assessment-${crypto.randomUUID()}.db` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const base = '2026-08-01T00:00:00.000Z';
const committedAt = '2026-08-02T00:00:00.000Z';

function replayReport(overrides: Partial<RestorePrivacyReconciliationReport> = {}): RestorePrivacyReconciliationReport {
  return {
    reportVersion: 1,
    backupCutoff: base,
    status: 'REPLAY_REQUIRED',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: {
      generatedAt: '2026-08-03T00:00:00.000Z',
      entriesFingerprint: `sha256:${'a'.repeat(64)}`,
      entryCount: 1,
    },
    journalMarkerCount: 2,
    obligations: [{
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      executionId: 'execution-a',
      approvalId: 'approval-a',
      deletionRequestId: 'deletion-a',
      executionVersion: 1,
      policyVersion: '1.6.0',
      scopeFingerprint: `sha256:${'b'.repeat(64)}`,
      capabilityFingerprint: `sha256:${'c'.repeat(64)}`,
      dbCommittedAt: committedAt,
      sources: ['LEDGER', 'JOURNAL'],
    }],
    blockers: [],
    ...overrides,
  };
}

async function seedTenant(db: Database) {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10, createdAt: base, updatedAt: base,
  });
}

async function seedAthlete(db: Database, tombstoned = false) {
  const tombstone = athleteTombstoneV1();
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a',
    linkedUserId: tombstoned ? tombstone.linkedUserId : null,
    firstName: tombstoned ? tombstone.firstName : 'Petra',
    lastName: tombstoned ? tombstone.lastName : 'Muster',
    birthDate: tombstoned ? tombstone.birthDate : '1980-01-01',
    referenceCategory: tombstoned ? tombstone.referenceCategory : 'MASTERS',
    heightCm: tombstoned ? tombstone.heightCm : 175,
    currentWeightKgX100: tombstoned ? tombstone.currentWeightKgX100 : 6900,
    primarySport: tombstoned ? tombstone.primarySport : 'ROWING',
    primaryDiscipline: tombstoned ? tombstone.primaryDiscipline : 'SINGLE',
    trainingStatus: tombstoned ? tombstone.trainingStatus : 'TRAINED',
    consentBlockedAt: committedAt,
    deletedAt: committedAt,
    createdAt: base,
    updatedAt: committedAt,
  });
}

async function seedDeletionRequest(db: Database, redacted: boolean) {
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: redacted ? AUDIT_PRIVACY_REDACTED_TEXT : 'Please remove my data',
    requestedAt: base, decidedAt: base,
    decisionReason: redacted ? AUDIT_PRIVACY_REDACTED_TEXT : 'Approved by admin',
    completedAt: base, createdAt: base, updatedAt: committedAt,
  });
}

describe('restore privacy replay database assessment', () => {
  it('reports database replay when the pre-anonymization athlete state remains', async () => {
    const db = await createTestDatabase();
    await seedTenant(db);
    await seedAthlete(db, false);
    await seedDeletionRequest(db, false);

    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport());

    expect(assessment.status).toBe('DATABASE_REPLAY_REQUIRED');
    expect(assessment.promotionAllowed).toBe(false);
    expect(assessment.artifactVerificationRequired).toBe(true);
    expect(assessment.obligations).toHaveLength(1);
    expect(assessment.obligations[0]?.reasons).toEqual([
      'ATHLETE_TOMBSTONE_MISSING',
      'DELETION_REQUEST_TEXT_NOT_REDACTED',
    ]);
  });

  it('proves the database half satisfied from the signed obligation plus exact target state', async () => {
    const db = await createTestDatabase();
    await seedTenant(db);
    await seedAthlete(db, true);
    await seedDeletionRequest(db, true);

    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport());

    expect(assessment.status).toBe('DATABASE_SATISFIED');
    expect(assessment.obligations[0]).toMatchObject({
      executionId: 'execution-a',
      status: 'DATABASE_SATISFIED',
      reasons: [],
      counts: {
        tests: 0,
        athleteSnapshots: 0,
        coachAssignments: 0,
        guardians: 0,
        dataSubjectExportPackages: 0,
        tenantExportPackages: 0,
        deletionRequestsWithUnredactedText: 0,
      },
    });
    expect(assessment.promotionAllowed).toBe(false);
    expect(assessment.artifactVerificationRequired).toBe(true);
  });

  it('does not require a post-backup historical audit event that cannot exist in the restored snapshot', async () => {
    const db = await createTestDatabase();
    await seedTenant(db);
    await seedAthlete(db, true);
    await seedDeletionRequest(db, true);

    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport());
    expect(assessment.status).toBe('DATABASE_SATISFIED');
  });

  it('fails closed when the signed obligation cannot resolve its athlete anchor in staging', async () => {
    const db = await createTestDatabase();
    await seedTenant(db);

    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport());

    expect(assessment.status).toBe('BLOCKED');
    expect(assessment.obligations[0]).toEqual({
      executionId: 'execution-a',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      status: 'BLOCKED',
      reasons: ['ATHLETE_STATE_UNRESOLVED'],
      counts: null,
    });
  });

  it('requires the exact signed deletion request anchor to remain completed', async () => {
    const db = await createTestDatabase();
    await seedTenant(db);
    await seedAthlete(db, true);
    await seedDeletionRequest(db, true);

    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport({
      obligations: [{
        ...replayReport().obligations[0]!,
        deletionRequestId: 'missing-deletion-request',
      }],
    }));

    expect(assessment.status).toBe('DATABASE_REPLAY_REQUIRED');
    expect(assessment.obligations[0]?.reasons).toEqual(['DELETION_REQUEST_STATE_UNRESOLVED']);
  });

  it('does not inspect the staging database when reconciliation itself is blocked', async () => {
    const db = await createTestDatabase();
    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport({
      status: 'BLOCKED',
      reconciliationReady: false,
      blockers: [{ code: 'OPEN_PENDING_INTENT', executionId: 'execution-a' }],
    }));

    expect(assessment).toEqual({
      assessmentVersion: 1,
      backupCutoff: base,
      status: 'BLOCKED',
      promotionAllowed: false,
      artifactVerificationRequired: true,
      obligations: [],
    });
  });

  it('treats a clear reconciliation report as database-satisfied without claiming promotion readiness', async () => {
    const db = await createTestDatabase();
    const assessment = await assessRestorePrivacyReplayDatabase(db, replayReport({
      status: 'CLEAR',
      obligations: [],
      ledger: {
        generatedAt: '2026-08-03T00:00:00.000Z',
        entriesFingerprint: `sha256:${'d'.repeat(64)}`,
        entryCount: 0,
      },
    }));

    expect(assessment).toEqual({
      assessmentVersion: 1,
      backupCutoff: base,
      status: 'DATABASE_SATISFIED',
      promotionAllowed: false,
      artifactVerificationRequired: false,
      obligations: [],
    });
  });
});
