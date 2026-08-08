import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { appendAuditEvent } from '../src/services/audit';
import { ANONYMIZATION_POLICY_VERSION } from '../src/services/anonymization-policy';
import { ATHLETE_TOMBSTONE_TEXT } from '../src/services/anonymization-tombstone';
import { AUDIT_PRIVACY_REDACTED_TEXT } from '../src/services/audit-privacy-redaction';
import { replayRestorePrivacyObligationToDatabase } from '../src/services/restore-privacy-db-replay';
import type {
  RestorePrivacyReconciliationReport,
  RestorePrivacyReplayObligation,
} from '../src/services/restore-privacy-reconciliation-report';
import { assessRestorePrivacyReplayDatabase } from '../src/services/restore-privacy-replay-assessment';

const createdAt = '2020-01-01T00:00:00.000Z';
const committedAt = '2026-08-06T10:00:00.000Z';
const replayedAt = '2026-08-08T08:00:00.000Z';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-restore-privacy-replay-${crypto.randomUUID()}.db` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

function obligation(overrides: Partial<RestorePrivacyReplayObligation> = {}): RestorePrivacyReplayObligation {
  return {
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    executionId: 'execution-after-backup-a',
    approvalId: 'approval-after-backup-a',
    deletionRequestId: 'deletion-after-backup-a',
    executionVersion: 1,
    policyVersion: ANONYMIZATION_POLICY_VERSION,
    scopeFingerprint: `sha256:${'a'.repeat(64)}`,
    capabilityFingerprint: `sha256:${'b'.repeat(64)}`,
    dbCommittedAt: committedAt,
    sources: ['LEDGER', 'JOURNAL'],
    ...overrides,
  };
}

function replayReport(): RestorePrivacyReconciliationReport {
  return {
    reportVersion: 1,
    backupCutoff: '2026-08-01T00:00:00.000Z',
    status: 'REPLAY_REQUIRED',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: {
      generatedAt: '2026-08-07T00:00:00.000Z',
      entriesFingerprint: `sha256:${'c'.repeat(64)}`,
      entryCount: 1,
    },
    journalMarkerCount: 2,
    obligations: [obligation()],
    blockers: [],
  };
}

async function seedRestoredPreAnonymizationState(db: Database): Promise<void> {
  await db.insert(schema.tenants).values([
    { id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB', timezone: 'Europe/Berlin', locale: 'de', retentionYears: 5, createdAt, updatedAt: createdAt },
    { id: 'tenant-b', slug: 'tenant-b', name: 'Tenant B', deploymentMode: 'CLUB', timezone: 'Europe/Berlin', locale: 'de', retentionYears: 5, createdAt, updatedAt: createdAt },
  ]);
  await db.insert(schema.users).values([
    { id: 'athlete-user-a', email: 'athlete@example.test', displayName: 'Athlete A', preferredLocale: 'de', createdAt, updatedAt: createdAt },
    { id: 'coach-a', email: 'coach@example.test', displayName: 'Coach A', preferredLocale: 'de', createdAt, updatedAt: createdAt },
    { id: 'admin-a', email: 'admin@example.test', displayName: 'Admin A', preferredLocale: 'de', createdAt, updatedAt: createdAt },
  ]);
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: 'athlete-user-a', firstName: 'Ada', lastName: 'Athlete',
    birthDate: '1985-05-05', referenceCategory: 'MASTERS', heightCm: 170, currentWeightKgX100: 6500,
    primarySport: 'ROWING', primaryDiscipline: 'SINGLE', trainingStatus: 'TRAINED',
    consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteSnapshots).values({
    id: 'snapshot-a', tenantId: 'tenant-a', athleteId: 'athlete-a', snapshotJson: '{"firstName":"Ada"}', version: 1,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.coachAthleteAssignments).values({
    id: 'assignment-a', tenantId: 'tenant-a', athleteId: 'athlete-a', coachUserId: 'coach-a', isPrimary: true,
    validFrom: createdAt, validUntil: null, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.consents).values({
    id: 'consent-a', tenantId: 'tenant-a', athleteId: 'athlete-a', consentType: 'DIAGNOSTICS', status: 'GRANTED',
    grantedAt: createdAt, withdrawnAt: null, documentVersion: '1', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteGuardians).values({
    id: 'guardian-a', tenantId: 'tenant-a', athleteId: 'athlete-a', fullName: 'Guardian Person', relationship: 'parent',
    email: 'guardian@example.test', phone: '+49123', authorityConfirmedAt: createdAt, validUntil: null, revokedAt: null,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'old-deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'REQUESTED', reason: 'Personal reason',
    requestedAt: '2025-01-01T00:00:00.000Z', decidedAt: null, decisionReason: null, completedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
  });
  await db.insert(schema.protocolTemplates).values({
    id: 'protocol-a', tenantId: 'tenant-a', deviceType: 'ROWERG', name: 'Protocol A', active: true, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.protocolTemplateVersions).values({
    id: 'protocol-version-a', tenantId: 'tenant-a', templateId: 'protocol-a', versionNumber: 1,
    createdByUserId: 'admin-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tests).values({
    id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
    conductingTrainerUserId: 'coach-a', scheduledAt: createdAt, startedAt: createdAt, endedAt: createdAt,
    currentVersion: 1, releasedAt: createdAt, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testPlanSnapshots).values({
    id: 'plan-a', tenantId: 'tenant-a', testId: 'test-a', protocolVersionId: 'protocol-version-a', athleteSnapshotId: 'snapshot-a',
    expectedLt2Watts: 300, startWatts: 180, incrementWatts: 30, maximumStages: 8, snapshotJson: '{"athlete":"Ada"}', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testSafetyChecklistConfirmations).values({
    id: 'safety-a', tenantId: 'tenant-a', testId: 'test-a', checklistVersion: '1', confirmationsJson: '{}',
    confirmedByUserId: 'coach-a', confirmedAt: createdAt, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testTerminationEvents).values({
    id: 'termination-a', tenantId: 'tenant-a', testId: 'test-a', reason: 'REGULAR_EXHAUSTION', notes: 'personal note',
    endedByUserId: 'coach-a', endedAt: createdAt, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.diagnosticResultSnapshots).values({
    id: 'diagnostic-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1, schemaVersion: '1',
    canonicalization: 'diagnostic-json-v1', resultHash: `sha256:${'d'.repeat(64)}`, resultJson: '{"name":"Ada"}',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.interpretations).values({
    id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1, lt1Json: '{}', lt2Json: '{}',
    rationale: 'individual', status: 'RELEASED', releasedAt: createdAt, releasedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.reportVersions).values({
    id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a', versionNumber: 1,
    locale: 'de', contentHash: `sha256:${'e'.repeat(64)}`, storageReference: 'tenant-a/test-a/report.pdf', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tenantExportPackages).values([
    { id: 'export-a', tenantId: 'tenant-a', tokenHash: `sha256:${'f'.repeat(64)}`, storageReference: 'tenant-a.mde', packageSha256: `sha256:${'1'.repeat(64)}`, createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null, createdAt, updatedAt: createdAt },
    { id: 'export-b', tenantId: 'tenant-b', tokenHash: `sha256:${'2'.repeat(64)}`, storageReference: 'tenant-b.mde', packageSha256: `sha256:${'3'.repeat(64)}`, createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null, createdAt, updatedAt: createdAt },
  ]);
  await appendAuditEvent(db, {
    tenantId: 'tenant-a', actorUserId: 'athlete-user-a', actorRole: 'ATHLETE', sessionId: 'session-a',
    action: 'athlete.updated', entityType: 'athlete', entityId: 'athlete-a', source: 'WEB', reason: 'Ada changed profile',
    before: { firstName: 'Ada' }, after: { firstName: 'Ada-Maria' }, occurredAt: '2024-01-01T00:00:00.000Z',
  });
}

describe('isolated restore privacy database replay', () => {
  it('uses a transient ACTIVE authorization and reaches the read-only database assessment target', async () => {
    const db = await createTestDatabase();
    await seedRestoredPreAnonymizationState(db);

    await expect(db.delete(schema.reportVersions).where(eq(schema.reportVersions.id, 'report-a'))).rejects.toThrow();
    expect((await assessRestorePrivacyReplayDatabase(db, replayReport())).status).toBe('DATABASE_REPLAY_REQUIRED');

    const first = await replayRestorePrivacyObligationToDatabase(db, obligation(), replayedAt);
    expect(first.result).toBe('APPLIED');
    expect(first.auditEventsRedacted).toBeGreaterThan(0);

    const [athlete] = await db.select().from(schema.athletes).where(eq(schema.athletes.id, 'athlete-a'));
    expect(athlete?.firstName).toBe(ATHLETE_TOMBSTONE_TEXT);
    expect(athlete?.linkedUserId).toBeNull();
    expect(athlete?.deletedAt).toBe(committedAt);
    expect(athlete?.consentBlockedAt).toBe(committedAt);

    expect(await db.select().from(schema.tests).where(eq(schema.tests.athleteId, 'athlete-a'))).toHaveLength(0);
    expect(await db.select().from(schema.athleteSnapshots).where(eq(schema.athleteSnapshots.athleteId, 'athlete-a'))).toHaveLength(0);
    expect(await db.select().from(schema.athleteGuardians).where(eq(schema.athleteGuardians.athleteId, 'athlete-a'))).toHaveLength(0);
    expect(await db.select().from(schema.coachAthleteAssignments).where(eq(schema.coachAthleteAssignments.athleteId, 'athlete-a'))).toHaveLength(0);
    expect(await db.select().from(schema.consents).where(eq(schema.consents.athleteId, 'athlete-a'))).toHaveLength(1);

    const deletionRows = await db.select().from(schema.athleteDeletionRequests).where(eq(schema.athleteDeletionRequests.athleteId, 'athlete-a'));
    expect(deletionRows.every((row) => row.reason === AUDIT_PRIVACY_REDACTED_TEXT && row.decisionReason === AUDIT_PRIVACY_REDACTED_TEXT)).toBe(true);
    expect(deletionRows.find((row) => row.id === 'deletion-after-backup-a')?.status).toBe('COMPLETED');

    expect(await db.select().from(schema.tenantExportPackages).where(eq(schema.tenantExportPackages.tenantId, 'tenant-a'))).toHaveLength(0);
    expect(await db.select().from(schema.tenantExportPackages).where(eq(schema.tenantExportPackages.tenantId, 'tenant-b'))).toHaveLength(1);
    expect((await assessRestorePrivacyReplayDatabase(db, replayReport())).status).toBe('DATABASE_SATISFIED');

    const [receipt] = await db.select().from(schema.restorePrivacyReplayAuthorizations).where(
      eq(schema.restorePrivacyReplayAuthorizations.executionId, 'execution-after-backup-a'),
    );
    expect(receipt?.status).toBe('APPLIED');
    expect(receipt?.appliedAt).toBe(replayedAt);

    const second = await replayRestorePrivacyObligationToDatabase(db, obligation(), '2026-08-08T09:00:00.000Z');
    expect(second.result).toBe('ALREADY_APPLIED');
    expect(second.replayedAt).toBe(replayedAt);
  });

  it('fails closed when the signed obligation cannot resolve its athlete anchor', async () => {
    const db = await createTestDatabase();
    await expect(replayRestorePrivacyObligationToDatabase(db, obligation({ athleteId: 'athlete-created-after-backup' }), replayedAt))
      .rejects.toThrow(/athlete anchor cannot be resolved/);
    expect(await db.select().from(schema.restorePrivacyReplayAuthorizations)).toHaveLength(0);
  });

  it('never leaves a reusable ACTIVE authorization when a receipt identity conflicts', async () => {
    const db = await createTestDatabase();
    await seedRestoredPreAnonymizationState(db);
    await replayRestorePrivacyObligationToDatabase(db, obligation(), replayedAt);
    await expect(replayRestorePrivacyObligationToDatabase(db, obligation({ approvalId: 'different-approval' }), replayedAt))
      .rejects.toThrow(/conflicts/);
    const active = await db.select().from(schema.restorePrivacyReplayAuthorizations).where(and(
      eq(schema.restorePrivacyReplayAuthorizations.executionId, 'execution-after-backup-a'),
      eq(schema.restorePrivacyReplayAuthorizations.status, 'ACTIVE'),
    ));
    expect(active).toHaveLength(0);
  });
});
