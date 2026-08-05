import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { appendAuditEvent } from '../src/services/audit';
import { approveAthleteAnonymization } from '../src/services/anonymization-approval';
import { commitStagedAthleteAnonymizationDatabase } from '../src/services/anonymization-db-commit';
import {
  listAthleteAnonymizationExecutionArtifacts,
  prepareAthleteAnonymizationExecution,
} from '../src/services/anonymization-execution';
import type { GlobalPrivacyCapabilities } from '../src/services/global-privacy-policy';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-anonymization-db-commit-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const createdAt = '2019-01-01T00:00:00.000Z';
const deletedAt = '2025-01-03T00:00:00.000Z';
const assessedAt = '2026-08-05T13:00:00.000Z';
const stagedAt = '2026-08-05T13:06:00.000Z';
const committedAt = '2026-08-05T13:07:00.000Z';

const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};
const capabilities: GlobalPrivacyCapabilities = {
  backup: { state: 'DISABLED' }, notifications: { state: 'DISABLED' },
};

async function seedCompleteAthleteScope(db: Database) {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 1, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values([
    { id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de', createdAt, updatedAt: createdAt },
    { id: 'athlete-user-a', email: 'petra@example.test', displayName: 'Petra Muster', preferredLocale: 'de', createdAt, updatedAt: createdAt },
    { id: 'coach-a', email: 'coach@example.test', displayName: 'Coach', preferredLocale: 'de', createdAt, updatedAt: createdAt },
  ]);
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: 'athlete-user-a',
    firstName: 'Petra', lastName: 'Muster', birthDate: '1980-01-01', referenceCategory: 'MASTERS',
    heightCm: 175, currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: deletedAt, deletedAt, createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.athleteSnapshots).values({
    id: 'athlete-snapshot-a', tenantId: 'tenant-a', athleteId: 'athlete-a',
    snapshotJson: '{"firstName":"Petra","lastName":"Muster","birthDate":"1980-01-01"}', version: 1,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.coachAthleteAssignments).values({
    id: 'assignment-a', tenantId: 'tenant-a', athleteId: 'athlete-a', coachUserId: 'coach-a',
    isPrimary: true, validFrom: createdAt, validUntil: deletedAt, createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.consents).values({
    id: 'consent-a', tenantId: 'tenant-a', athleteId: 'athlete-a', consentType: 'DIAGNOSTICS',
    status: 'WITHDRAWN', grantedAt: createdAt, withdrawnAt: deletedAt, documentVersion: '1',
    createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.athleteGuardians).values({
    id: 'guardian-a', tenantId: 'tenant-a', athleteId: 'athlete-a', fullName: 'Guardian Muster',
    relationship: 'parent', email: 'guardian@example.test', phone: '+49123456789',
    authorityConfirmedAt: createdAt, validUntil: null, revokedAt: deletedAt, createdAt, updatedAt: deletedAt,
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
    conductingTrainerUserId: 'coach-a', scheduledAt: '2020-01-01T09:00:00.000Z',
    startedAt: '2020-01-01T10:00:00.000Z', endedAt: '2020-01-01T11:00:00.000Z',
    releasedAt: '2020-01-01T12:00:00.000Z', currentVersion: 3,
    createdAt: '2020-01-01T09:00:00.000Z', updatedAt: '2020-01-01T12:00:00.000Z',
  });
  await db.insert(schema.testPlanSnapshots).values({
    id: 'plan-a', tenantId: 'tenant-a', testId: 'test-a', protocolVersionId: 'protocol-version-a',
    athleteSnapshotId: 'athlete-snapshot-a', expectedLt2Watts: 300, startWatts: 180,
    incrementWatts: 30, maximumStages: 8, snapshotJson: '{"athlete":"Petra Muster"}',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testSafetyChecklistConfirmations).values({
    id: 'safety-a', tenantId: 'tenant-a', testId: 'test-a', checklistVersion: '1',
    confirmationsJson: '{}', confirmedByUserId: 'coach-a', confirmedAt: '2020-01-01T09:55:00.000Z',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testTerminationEvents).values({
    id: 'termination-a', tenantId: 'tenant-a', testId: 'test-a', reason: 'REGULAR_EXHAUSTION',
    notes: 'Petra completed test', endedByUserId: 'coach-a', endedAt: '2020-01-01T11:00:00.000Z',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testStages).values({
    id: 'stage-a', tenantId: 'tenant-a', testId: 'test-a', stageNumber: 1,
    targetWatts: 180, plannedSeconds: 240, actualSeconds: 240, meanWatts: 180, endWatts: 185,
    meanHeartRate: 130, endHeartRate: 135, meanCadence: 28, endCadence: 29, distanceMeters: 1000,
    lactateValueX100: 120, lactateQualifier: 'EXACT', lactateMeasuredAt: '2020-01-01T10:05:00.000Z',
    rpeX10: 30, qualityStatus: 'VALID', dataSource: 'MANUAL', notes: null, currentVersion: 1,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.restMeasurements).values({
    id: 'rest-a', tenantId: 'tenant-a', testId: 'test-a', heartRate: 55, lactateValueX100: 90,
    lactateQualifier: 'EXACT', measuredAt: '2020-01-01T09:50:00.000Z', currentVersion: 1,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.recoveryMeasurements).values({
    id: 'recovery-a', tenantId: 'tenant-a', testId: 'test-a', targetOffsetSeconds: 300,
    actualOffsetSeconds: 300, heartRate: 90, lactateValueX100: 300, lactateQualifier: 'EXACT',
    measuredAt: '2020-01-01T11:05:00.000Z', currentVersion: 1, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.testLocks).values({
    id: 'lock-a', tenantId: 'tenant-a', testId: 'test-a', ownerUserId: 'coach-a', tokenHash: 'lock-hash',
    acquiredAt: '2020-01-01T09:50:00.000Z', expiresAt: '2020-01-01T12:00:00.000Z',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.syncOperations).values({
    id: 'sync-a', tenantId: 'tenant-a', operationId: 'operation-a', testId: 'test-a', entityId: 'stage-a',
    expectedVersion: 1, occurredAt: '2020-01-01T10:05:00.000Z', operationType: 'MEASUREMENT',
    schemaVersion: '1', payloadJson: '{}', status: 'APPLIED', resultJson: '{}',
    appliedAt: '2020-01-01T10:05:01.000Z', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.qualityFlags).values({
    id: 'quality-a', tenantId: 'tenant-a', testId: 'test-a', stageId: 'stage-a',
    code: 'TEST', severity: 'WARNING', messageKey: 'quality.test', acknowledgedAt: null,
    acknowledgedByUserId: null, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.measurementCorrections).values({
    id: 'correction-a', tenantId: 'tenant-a', testId: 'test-a', entityType: 'stage', entityId: 'stage-a',
    fieldName: 'lactate', oldValueJson: '1.1', newValueJson: '1.2', reason: 'Correction',
    correctedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.thresholdRuns).values({
    id: 'threshold-run-a', tenantId: 'tenant-a', testId: 'test-a', algorithm: 'Dmax', algorithmVersion: '1',
    inputHash: 'input-hash', inputJson: '{}', coefficientsJson: '{}', warningsJson: '[]',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.thresholdResults).values({
    id: 'threshold-result-a', tenantId: 'tenant-a', thresholdRunId: 'threshold-run-a', thresholdType: 'LT2',
    wattsX100: 30000, lactateX100: 400, heartRateX100: 16000, valid: true, resultJson: '{}',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.diagnosticResultSnapshots).values({
    id: 'diagnostic-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    schemaVersion: '1', canonicalization: 'diagnostic-json-v1', resultHash: `sha256:${'a'.repeat(64)}`,
    resultJson: '{"athlete":"Petra Muster"}', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.interpretations).values({
    id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    lt1Json: '{}', lt2Json: '{}', rationale: 'Petra individual result', status: 'RELEASED',
    releasedAt: '2020-01-01T12:00:00.000Z', releasedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.zoneProfiles).values({
    id: 'zones-a', tenantId: 'tenant-a', interpretationId: 'interpretation-a', modelType: 'FIVE_ZONE',
    powerZonesJson: '{}', heartRateZonesJson: '{}', ruleVersion: '1', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.reportVersions).values({
    id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a',
    versionNumber: 1, locale: 'de', contentHash: `sha256:${'b'.repeat(64)}`,
    storageReference: 'tenant-a/test-a/de/report-a.pdf', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tenantExportPackages).values({
    id: 'export-a', tenantId: 'tenant-a', tokenHash: `sha256:${'c'.repeat(64)}`,
    storageReference: '01234567-89ab-cdef-0123-456789abcdef.mde', packageSha256: `sha256:${'d'.repeat(64)}`,
    createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Petra requested deletion', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Approved for Petra', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
  await appendAuditEvent(db, {
    tenantId: 'tenant-a', actorUserId: 'athlete-user-a', actorRole: 'ATHLETE',
    sessionId: 'athlete-session-a', authProvider: 'BETTER_AUTH',
    action: 'athlete.updated', entityType: 'athlete', entityId: 'athlete-a', source: 'WEB',
    reason: 'Petra Muster correction', before: { firstName: 'Petra', birthDate: '1980-01-01' },
    after: { firstName: 'Petra-Maria', birthDate: '1980-01-01' },
    occurredAt: '2021-01-01T00:00:00.000Z',
  });
}

async function prepareStagedExecution(db: Database) {
  const approval = await approveAthleteAnonymization(
    db, 'tenant-a', 'athlete-a', actor, capabilities, assessedAt,
  );
  const execution = await prepareAthleteAnonymizationExecution(
    db, 'tenant-a', 'athlete-a', approval.id, actor, capabilities, '2026-08-05T13:05:00.000Z',
  );
  await db.update(schema.athleteAnonymizationExecutions).set({
    status: 'ARTIFACTS_STAGED', artifactsStagedAt: stagedAt, updatedAt: stagedAt,
  }).where(eq(schema.athleteAnonymizationExecutions.id, execution.id));
  return { approval, execution };
}

describe('transactional athlete anonymization database commit', () => {
  it('redacts audit/history, removes detailed data and commits the technical tombstone atomically', async () => {
    const db = await createTestDatabase();
    await seedCompleteAthleteScope(db);
    const { approval, execution } = await prepareStagedExecution(db);
    const manifestBefore = await listAthleteAnonymizationExecutionArtifacts(db, 'tenant-a', execution.id);

    const summary = await commitStagedAthleteAnonymizationDatabase(
      db, 'tenant-a', 'athlete-a', execution.id, actor, capabilities, committedAt,
    );

    expect(summary).toMatchObject({
      executionId: execution.id,
      committedAt,
      auditEventsRedacted: 1,
      athleteTombstoneVersion: 1,
    });
    expect(summary.removed).toMatchObject({
      reportVersions: 1, zoneProfiles: 1, interpretations: 1,
      thresholdResults: 1, thresholdRuns: 1, diagnosticResultSnapshots: 1,
      measurementCorrections: 1, qualityFlags: 1, syncOperations: 1, testLocks: 1,
      recoveryMeasurements: 1, restMeasurements: 1, testStages: 1,
      testTerminationEvents: 1, testSafetyChecklistConfirmations: 1, testPlanSnapshots: 1,
      tests: 1, athleteSnapshots: 1, coachAssignments: 1, guardians: 1,
      tenantExportPackages: 1,
    });

    const [athlete] = await db.select().from(schema.athletes).where(eq(schema.athletes.id, 'athlete-a'));
    expect(athlete).toMatchObject({
      linkedUserId: null, firstName: '[ANONYMIZED]', lastName: '[ANONYMIZED]',
      birthDate: '0001-01-01', referenceCategory: '[ANONYMIZED]', heightCm: 0,
      currentWeightKgX100: 0, primarySport: '[ANONYMIZED]', primaryDiscipline: '[ANONYMIZED]',
      trainingStatus: '[ANONYMIZED]', deletedAt, consentBlockedAt: deletedAt,
    });

    expect(await db.select().from(schema.consents)).toHaveLength(1);
    const [request] = await db.select().from(schema.athleteDeletionRequests);
    expect(request).toMatchObject({
      id: 'deletion-a', status: 'COMPLETED', reason: '[REDACTED]', decisionReason: '[REDACTED]',
      requestedAt: '2025-01-01T00:00:00.000Z', completedAt: deletedAt,
    });

    for (const table of [
      schema.reportVersions, schema.zoneProfiles, schema.interpretations, schema.thresholdResults,
      schema.thresholdRuns, schema.diagnosticResultSnapshots, schema.measurementCorrections,
      schema.qualityFlags, schema.syncOperations, schema.testLocks, schema.recoveryMeasurements,
      schema.restMeasurements, schema.testStages, schema.testTerminationEvents,
      schema.testSafetyChecklistConfirmations, schema.testPlanSnapshots, schema.tests,
      schema.athleteSnapshots, schema.coachAthleteAssignments, schema.athleteGuardians,
      schema.tenantExportPackages,
    ] as const) {
      expect(await db.select().from(table)).toHaveLength(0);
    }

    const [storedExecution] = await db.select().from(schema.athleteAnonymizationExecutions)
      .where(eq(schema.athleteAnonymizationExecutions.id, execution.id));
    expect(storedExecution).toMatchObject({ status: 'DB_COMMITTED', dbCommittedAt: committedAt });
    expect(await listAthleteAnonymizationExecutionArtifacts(db, 'tenant-a', execution.id))
      .toEqual(manifestBefore);
    expect(await db.select().from(schema.athleteAnonymizationApprovals)
      .where(eq(schema.athleteAnonymizationApprovals.id, approval.id))).toHaveLength(1);

    const redactions = await db.select().from(schema.auditEventPrivacyRedactions);
    expect(redactions).toHaveLength(1);
    const historicAudit = (await db.select().from(schema.auditEvents))
      .find((row) => row.action === 'athlete.updated');
    expect(historicAudit).toMatchObject({
      actorUserId: null, sessionId: null, reason: '[REDACTED]',
      beforeJson: '{"auditSchemaVersion":3,"privacyRedacted":true}',
      afterJson: '{"auditSchemaVersion":3,"privacyRedacted":true}',
    });
    const commitAudit = (await db.select().from(schema.auditEvents))
      .find((row) => row.action === 'athlete.anonymization_db_committed');
    expect(commitAudit?.afterJson).toContain('"athleteTombstoneVersion":1');
    expect(commitAudit?.afterJson).not.toContain('Petra');
    expect(commitAudit?.afterJson).not.toContain('Muster');
  });

  it('fails closed before mutation when a new active tenant export is outside the manifest', async () => {
    const db = await createTestDatabase();
    await seedCompleteAthleteScope(db);
    const { execution } = await prepareStagedExecution(db);
    await db.insert(schema.tenantExportPackages).values({
      id: 'export-late', tenantId: 'tenant-a', tokenHash: `sha256:${'e'.repeat(64)}`,
      storageReference: 'fedcba98-7654-3210-fedc-ba9876543210.mde', packageSha256: `sha256:${'f'.repeat(64)}`,
      createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
      createdAt: stagedAt, updatedAt: stagedAt,
    });

    await expect(commitStagedAthleteAnonymizationDatabase(
      db, 'tenant-a', 'athlete-a', execution.id, actor, capabilities, committedAt,
    )).rejects.toThrow(/approval is no longer valid|Active tenant export appeared|fingerprint/i);

    const [athlete] = await db.select().from(schema.athletes).where(eq(schema.athletes.id, 'athlete-a'));
    expect(athlete?.firstName).toBe('Petra');
    expect(await db.select().from(schema.tests)).toHaveLength(1);
    const [storedExecution] = await db.select().from(schema.athleteAnonymizationExecutions)
      .where(eq(schema.athleteAnonymizationExecutions.id, execution.id));
    expect(storedExecution?.status).toBe('ARTIFACTS_STAGED');
    expect(await db.select().from(schema.auditEventPrivacyRedactions)).toHaveLength(0);
  });
});
