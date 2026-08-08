import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteDataSubjectDeliveryPackages,
  athleteDeletionRequests,
  athleteGuardians,
  athleteSnapshots,
  athletes,
  coachAthleteAssignments,
  diagnosticResultSnapshots,
  interpretations,
  measurementCorrections,
  qualityFlags,
  recoveryMeasurements,
  reportVersions,
  restMeasurements,
  restorePrivacyReplayAuthorizations,
  syncOperations,
  tenantExportPackages,
  testLocks,
  testPlanSnapshots,
  testSafetyChecklistConfirmations,
  testStages,
  testTerminationEvents,
  tests,
  thresholdResults,
  thresholdRuns,
  zoneProfiles,
} from '../schema';
import { inventoryAthleteAuditPrivacyMaintenance } from './audit-privacy-inventory';
import {
  applyHistoricalAuditPrivacyRedactionInTransaction,
  AUDIT_PRIVACY_REDACTED_TEXT,
} from './audit-privacy-redaction';
import { ANONYMIZATION_POLICY_VERSION } from './anonymization-policy';
import { athleteTombstoneV1, ATHLETE_TOMBSTONE_VERSION } from './anonymization-tombstone';
import type { RestorePrivacyReplayObligation } from './restore-privacy-reconciliation-report';

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type RestorePrivacyDbReplayResult = 'APPLIED' | 'ALREADY_APPLIED';

export interface RestorePrivacyDbReplaySummary {
  readonly executionId: string;
  readonly result: RestorePrivacyDbReplayResult;
  readonly dbCommittedAt: string;
  readonly replayedAt: string;
  readonly auditEventsRedacted: number;
  readonly removed: Readonly<Record<string, number>>;
  readonly athleteTombstoneVersion: typeof ATHLETE_TOMBSTONE_VERSION;
}

function assertTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertObligation(obligation: Readonly<RestorePrivacyReplayObligation>): void {
  for (const [label, value] of [
    ['tenantId', obligation.tenantId],
    ['athleteId', obligation.athleteId],
    ['executionId', obligation.executionId],
    ['approvalId', obligation.approvalId],
    ['deletionRequestId', obligation.deletionRequestId],
    ['policyVersion', obligation.policyVersion],
  ] as const) {
    if (!value.trim()) throw new Error(`Restore privacy replay ${label} is required`);
  }
  if (!Number.isInteger(obligation.executionVersion) || obligation.executionVersion < 1) {
    throw new Error('Restore privacy replay execution version must be a positive integer');
  }
  if (!FINGERPRINT.test(obligation.scopeFingerprint) || !FINGERPRINT.test(obligation.capabilityFingerprint)) {
    throw new Error('Restore privacy replay fingerprints are invalid');
  }
  assertTimestamp(obligation.dbCommittedAt, 'Restore privacy replay DB commit time');
  if (obligation.policyVersion !== ANONYMIZATION_POLICY_VERSION) {
    throw new Error(`Unsupported restore anonymization policy version: ${obligation.policyVersion}`);
  }
}

function sameAuthorizationIdentity(
  row: typeof restorePrivacyReplayAuthorizations.$inferSelect,
  obligation: Readonly<RestorePrivacyReplayObligation>,
): boolean {
  return row.executionId === obligation.executionId
    && row.tenantId === obligation.tenantId
    && row.athleteId === obligation.athleteId
    && row.approvalId === obligation.approvalId
    && row.deletionRequestId === obligation.deletionRequestId
    && row.executionVersion === obligation.executionVersion
    && row.policyVersion === obligation.policyVersion
    && row.scopeFingerprint === obligation.scopeFingerprint
    && row.capabilityFingerprint === obligation.capabilityFingerprint
    && row.dbCommittedAt === obligation.dbCommittedAt;
}

async function deletedCount<T extends { id: unknown }>(promise: Promise<T[]>): Promise<number> {
  return (await promise).length;
}

async function ensureBoundDeletionRequest(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  obligation: Readonly<RestorePrivacyReplayObligation>,
): Promise<void> {
  const [existing] = await tx.select().from(athleteDeletionRequests).where(
    eq(athleteDeletionRequests.id, obligation.deletionRequestId),
  ).limit(1);

  if (existing && (existing.tenantId !== obligation.tenantId || existing.athleteId !== obligation.athleteId)) {
    throw new Error('Restore privacy replay deletion request anchor conflicts with the signed obligation');
  }

  if (existing) {
    await tx.update(athleteDeletionRequests).set({
      status: 'COMPLETED',
      reason: AUDIT_PRIVACY_REDACTED_TEXT,
      decidedAt: existing.decidedAt ?? obligation.dbCommittedAt,
      decisionReason: AUDIT_PRIVACY_REDACTED_TEXT,
      completedAt: existing.completedAt ?? obligation.dbCommittedAt,
      updatedAt: obligation.dbCommittedAt,
    }).where(eq(athleteDeletionRequests.id, obligation.deletionRequestId));
    return;
  }

  await tx.insert(athleteDeletionRequests).values({
    id: obligation.deletionRequestId,
    tenantId: obligation.tenantId,
    athleteId: obligation.athleteId,
    status: 'COMPLETED',
    reason: AUDIT_PRIVACY_REDACTED_TEXT,
    requestedAt: obligation.dbCommittedAt,
    decidedAt: obligation.dbCommittedAt,
    decisionReason: AUDIT_PRIVACY_REDACTED_TEXT,
    completedAt: obligation.dbCommittedAt,
    createdAt: obligation.dbCommittedAt,
    updatedAt: obligation.dbCommittedAt,
  });
}

async function applyDetailedRemoval(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  obligation: Readonly<RestorePrivacyReplayObligation>,
): Promise<Readonly<Record<string, number>>> {
  const { tenantId, athleteId, dbCommittedAt } = obligation;
  const testRows = await tx.select({ id: tests.id }).from(tests).where(and(
    eq(tests.tenantId, tenantId),
    eq(tests.athleteId, athleteId),
  ));
  const testIds = testRows.map((row) => row.id);
  const removed: Record<string, number> = {};

  if (testIds.length > 0) {
    const interpretationRows = await tx.select({ id: interpretations.id }).from(interpretations).where(and(
      eq(interpretations.tenantId, tenantId),
      inArray(interpretations.testId, testIds),
    ));
    const interpretationIds = interpretationRows.map((row) => row.id);
    const thresholdRunRows = await tx.select({ id: thresholdRuns.id }).from(thresholdRuns).where(and(
      eq(thresholdRuns.tenantId, tenantId),
      inArray(thresholdRuns.testId, testIds),
    ));
    const thresholdRunIds = thresholdRunRows.map((row) => row.id);

    removed.reportVersions = await deletedCount(tx.delete(reportVersions).where(and(
      eq(reportVersions.tenantId, tenantId), inArray(reportVersions.testId, testIds),
    )).returning({ id: reportVersions.id }));
    removed.zoneProfiles = interpretationIds.length === 0 ? 0 : await deletedCount(tx.delete(zoneProfiles).where(and(
      eq(zoneProfiles.tenantId, tenantId), inArray(zoneProfiles.interpretationId, interpretationIds),
    )).returning({ id: zoneProfiles.id }));
    removed.interpretations = await deletedCount(tx.delete(interpretations).where(and(
      eq(interpretations.tenantId, tenantId), inArray(interpretations.testId, testIds),
    )).returning({ id: interpretations.id }));
    removed.thresholdResults = thresholdRunIds.length === 0 ? 0 : await deletedCount(tx.delete(thresholdResults).where(and(
      eq(thresholdResults.tenantId, tenantId), inArray(thresholdResults.thresholdRunId, thresholdRunIds),
    )).returning({ id: thresholdResults.id }));
    removed.thresholdRuns = await deletedCount(tx.delete(thresholdRuns).where(and(
      eq(thresholdRuns.tenantId, tenantId), inArray(thresholdRuns.testId, testIds),
    )).returning({ id: thresholdRuns.id }));
    removed.diagnosticResultSnapshots = await deletedCount(tx.delete(diagnosticResultSnapshots).where(and(
      eq(diagnosticResultSnapshots.tenantId, tenantId), inArray(diagnosticResultSnapshots.testId, testIds),
    )).returning({ id: diagnosticResultSnapshots.id }));
    removed.measurementCorrections = await deletedCount(tx.delete(measurementCorrections).where(and(
      eq(measurementCorrections.tenantId, tenantId), inArray(measurementCorrections.testId, testIds),
    )).returning({ id: measurementCorrections.id }));
    removed.qualityFlags = await deletedCount(tx.delete(qualityFlags).where(and(
      eq(qualityFlags.tenantId, tenantId), inArray(qualityFlags.testId, testIds),
    )).returning({ id: qualityFlags.id }));
    removed.syncOperations = await deletedCount(tx.delete(syncOperations).where(and(
      eq(syncOperations.tenantId, tenantId), inArray(syncOperations.testId, testIds),
    )).returning({ id: syncOperations.id }));
    removed.testLocks = await deletedCount(tx.delete(testLocks).where(and(
      eq(testLocks.tenantId, tenantId), inArray(testLocks.testId, testIds),
    )).returning({ id: testLocks.id }));
    removed.recoveryMeasurements = await deletedCount(tx.delete(recoveryMeasurements).where(and(
      eq(recoveryMeasurements.tenantId, tenantId), inArray(recoveryMeasurements.testId, testIds),
    )).returning({ id: recoveryMeasurements.id }));
    removed.restMeasurements = await deletedCount(tx.delete(restMeasurements).where(and(
      eq(restMeasurements.tenantId, tenantId), inArray(restMeasurements.testId, testIds),
    )).returning({ id: restMeasurements.id }));
    removed.testStages = await deletedCount(tx.delete(testStages).where(and(
      eq(testStages.tenantId, tenantId), inArray(testStages.testId, testIds),
    )).returning({ id: testStages.id }));
    removed.testTerminationEvents = await deletedCount(tx.delete(testTerminationEvents).where(and(
      eq(testTerminationEvents.tenantId, tenantId), inArray(testTerminationEvents.testId, testIds),
    )).returning({ id: testTerminationEvents.id }));
    removed.testSafetyChecklistConfirmations = await deletedCount(tx.delete(testSafetyChecklistConfirmations).where(and(
      eq(testSafetyChecklistConfirmations.tenantId, tenantId), inArray(testSafetyChecklistConfirmations.testId, testIds),
    )).returning({ id: testSafetyChecklistConfirmations.id }));
    removed.testPlanSnapshots = await deletedCount(tx.delete(testPlanSnapshots).where(and(
      eq(testPlanSnapshots.tenantId, tenantId), inArray(testPlanSnapshots.testId, testIds),
    )).returning({ id: testPlanSnapshots.id }));
    removed.tests = await deletedCount(tx.delete(tests).where(and(
      eq(tests.tenantId, tenantId), inArray(tests.id, testIds),
    )).returning({ id: tests.id }));
  }

  removed.athleteSnapshots = await deletedCount(tx.delete(athleteSnapshots).where(and(
    eq(athleteSnapshots.tenantId, tenantId), eq(athleteSnapshots.athleteId, athleteId),
  )).returning({ id: athleteSnapshots.id }));
  removed.coachAssignments = await deletedCount(tx.delete(coachAthleteAssignments).where(and(
    eq(coachAthleteAssignments.tenantId, tenantId), eq(coachAthleteAssignments.athleteId, athleteId),
  )).returning({ id: coachAthleteAssignments.id }));
  removed.guardians = await deletedCount(tx.delete(athleteGuardians).where(and(
    eq(athleteGuardians.tenantId, tenantId), eq(athleteGuardians.athleteId, athleteId),
  )).returning({ id: athleteGuardians.id }));

  removed.tenantExportPackages = await deletedCount(tx.delete(tenantExportPackages).where(
    eq(tenantExportPackages.tenantId, tenantId),
  ).returning({ id: tenantExportPackages.id }));
  removed.dataSubjectDeliveryPackages = await deletedCount(tx.delete(athleteDataSubjectDeliveryPackages).where(and(
    eq(athleteDataSubjectDeliveryPackages.tenantId, tenantId),
    eq(athleteDataSubjectDeliveryPackages.athleteId, athleteId),
  )).returning({ id: athleteDataSubjectDeliveryPackages.id }));

  await tx.update(athleteDeletionRequests).set({
    reason: AUDIT_PRIVACY_REDACTED_TEXT,
    decisionReason: AUDIT_PRIVACY_REDACTED_TEXT,
    updatedAt: dbCommittedAt,
  }).where(and(
    eq(athleteDeletionRequests.tenantId, tenantId),
    eq(athleteDeletionRequests.athleteId, athleteId),
  ));
  await ensureBoundDeletionRequest(tx, obligation);

  return Object.freeze({ ...removed });
}

/**
 * Applies one cryptographically reconciled post-backup anonymization obligation to an isolated
 * restore database. The signed obligation is the authorization source because later productive
 * Approval/Execution rows are not guaranteed to exist in the selected older backup.
 */
export async function replayRestorePrivacyObligationToDatabase(
  db: Database,
  obligation: Readonly<RestorePrivacyReplayObligation>,
  replayedAt = new Date().toISOString(),
): Promise<Readonly<RestorePrivacyDbReplaySummary>> {
  assertObligation(obligation);
  assertTimestamp(replayedAt, 'Restore privacy replay time');
  if (replayedAt < obligation.dbCommittedAt) {
    throw new Error('Restore privacy replay time must not precede the original DB commit');
  }

  const [existingAuthorization] = await db.select().from(restorePrivacyReplayAuthorizations).where(
    eq(restorePrivacyReplayAuthorizations.executionId, obligation.executionId),
  ).limit(1);
  if (existingAuthorization) {
    if (!sameAuthorizationIdentity(existingAuthorization, obligation)) {
      throw new Error('Restore privacy replay receipt conflicts with the reconciled obligation');
    }
    if (existingAuthorization.status !== 'APPLIED' || !existingAuthorization.appliedAt) {
      throw new Error('Restore privacy replay authorization is unexpectedly left ACTIVE');
    }
    return Object.freeze({
      executionId: obligation.executionId,
      result: 'ALREADY_APPLIED',
      dbCommittedAt: obligation.dbCommittedAt,
      replayedAt: existingAuthorization.appliedAt,
      auditEventsRedacted: 0,
      removed: Object.freeze({}),
      athleteTombstoneVersion: ATHLETE_TOMBSTONE_VERSION,
    });
  }

  const [athleteBefore] = await db.select().from(athletes).where(and(
    eq(athletes.id, obligation.athleteId),
    eq(athletes.tenantId, obligation.tenantId),
  )).limit(1);
  if (!athleteBefore) {
    throw new Error('Restore privacy replay athlete anchor cannot be resolved in the selected backup');
  }
  const auditInventory = await inventoryAthleteAuditPrivacyMaintenance(
    db,
    obligation.tenantId,
    obligation.athleteId,
  );

  return db.transaction(async (tx) => {
    const [receiptRace] = await tx.select().from(restorePrivacyReplayAuthorizations).where(
      eq(restorePrivacyReplayAuthorizations.executionId, obligation.executionId),
    ).limit(1);
    if (receiptRace) throw new Error('Restore privacy replay receipt changed before transaction');

    await tx.insert(restorePrivacyReplayAuthorizations).values({
      executionId: obligation.executionId,
      tenantId: obligation.tenantId,
      athleteId: obligation.athleteId,
      approvalId: obligation.approvalId,
      deletionRequestId: obligation.deletionRequestId,
      executionVersion: obligation.executionVersion,
      policyVersion: obligation.policyVersion,
      scopeFingerprint: obligation.scopeFingerprint,
      capabilityFingerprint: obligation.capabilityFingerprint,
      dbCommittedAt: obligation.dbCommittedAt,
      status: 'ACTIVE',
      appliedAt: null,
      createdAt: replayedAt,
      updatedAt: replayedAt,
    });

    const [athlete] = await tx.select().from(athletes).where(and(
      eq(athletes.id, obligation.athleteId),
      eq(athletes.tenantId, obligation.tenantId),
    )).limit(1);
    if (!athlete) throw new Error('Restore privacy replay athlete anchor changed before transaction');

    const restoreActor = {
      userId: `restore-privacy-replay/${obligation.executionId}`,
      role: 'TENANT_ADMIN',
    };
    for (const candidate of auditInventory.candidates) {
      await applyHistoricalAuditPrivacyRedactionInTransaction(
        tx,
        obligation.tenantId,
        obligation.athleteId,
        restoreActor,
        candidate,
        `RESTORE-PRIVACY/${obligation.executionId}`,
        obligation.dbCommittedAt,
      );
    }
    const removed = await applyDetailedRemoval(tx, obligation);

    await tx.update(athletes).set({
      ...athleteTombstoneV1(),
      consentBlockedAt: athlete.consentBlockedAt ?? obligation.dbCommittedAt,
      deletedAt: athlete.deletedAt ?? obligation.dbCommittedAt,
      updatedAt: obligation.dbCommittedAt,
    }).where(and(
      eq(athletes.id, obligation.athleteId),
      eq(athletes.tenantId, obligation.tenantId),
    ));

    await tx.update(restorePrivacyReplayAuthorizations).set({
      status: 'APPLIED',
      appliedAt: replayedAt,
      updatedAt: replayedAt,
    }).where(and(
      eq(restorePrivacyReplayAuthorizations.executionId, obligation.executionId),
      eq(restorePrivacyReplayAuthorizations.status, 'ACTIVE'),
    ));

    return Object.freeze({
      executionId: obligation.executionId,
      result: 'APPLIED' as const,
      dbCommittedAt: obligation.dbCommittedAt,
      replayedAt,
      auditEventsRedacted: auditInventory.candidates.length,
      removed,
      athleteTombstoneVersion: ATHLETE_TOMBSTONE_VERSION,
    });
  });
}
