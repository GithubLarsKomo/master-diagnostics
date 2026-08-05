import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteAnonymizationApprovals,
  athleteAnonymizationExecutionArtifacts,
  athleteAnonymizationExecutions,
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
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import {
  applyHistoricalAuditPrivacyRedactionInTransaction,
  AUDIT_PRIVACY_REDACTED_TEXT,
} from './audit-privacy-redaction';
import { inventoryAthleteAuditPrivacyMaintenance } from './audit-privacy-inventory';
import { validateAthleteAnonymizationApproval } from './anonymization-approval';
import { ANONYMIZATION_POLICY_VERSION } from './anonymization-policy';
import { athleteTombstoneV1, ATHLETE_TOMBSTONE_VERSION } from './anonymization-tombstone';
import type { GlobalPrivacyCapabilities } from './global-privacy-policy';

export interface AthleteAnonymizationDatabaseCommitSummary {
  executionId: string;
  committedAt: string;
  auditEventsRedacted: number;
  removed: Readonly<Record<string, number>>;
  athleteTombstoneVersion: typeof ATHLETE_TOMBSTONE_VERSION;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function deletedCount<T extends { id: unknown }>(promise: Promise<T[]>): Promise<number> {
  return (await promise).length;
}

/**
 * Commits the database half of an already staged irreversible anonymization.
 * External artifacts must already be in execution-scoped quarantine and the
 * execution must be ARTIFACTS_STAGED. This function never touches filesystem
 * storage; a later orchestrator owns restore/purge semantics around it.
 */
export async function commitStagedAthleteAnonymizationDatabase(
  db: Database,
  tenantId: string,
  athleteId: string,
  executionId: string,
  actor: AuditActorContext,
  globalCapabilities: Readonly<GlobalPrivacyCapabilities>,
  committedAt = new Date().toISOString(),
): Promise<Readonly<AthleteAnonymizationDatabaseCommitSummary>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  if (!Number.isFinite(Date.parse(committedAt))) throw new Error('Commit time must be a valid ISO-8601 timestamp');

  const [execution] = await db.select().from(athleteAnonymizationExecutions).where(and(
    eq(athleteAnonymizationExecutions.id, executionId),
    eq(athleteAnonymizationExecutions.tenantId, tenantId),
    eq(athleteAnonymizationExecutions.athleteId, athleteId),
  )).limit(1);
  if (!execution || execution.status !== 'ARTIFACTS_STAGED') {
    throw new Error('ARTIFACTS_STAGED anonymization execution required');
  }

  const auditInventory = await inventoryAthleteAuditPrivacyMaintenance(db, tenantId, athleteId);
  const validation = await validateAthleteAnonymizationApproval(
    db,
    tenantId,
    athleteId,
    execution.approvalId,
    globalCapabilities,
    committedAt,
  );
  if (!validation.validForExecutionPreparation) {
    throw new Error(`Anonymization approval is no longer valid: ${validation.blockers.join(', ')}`);
  }

  const maintenanceReference = `ANONYMIZATION/${executionId}`;

  return db.transaction(async (tx) => {
    const [lockedExecution] = await tx.select().from(athleteAnonymizationExecutions).where(and(
      eq(athleteAnonymizationExecutions.id, executionId),
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      eq(athleteAnonymizationExecutions.athleteId, athleteId),
      eq(athleteAnonymizationExecutions.status, 'ARTIFACTS_STAGED'),
    )).limit(1);
    if (!lockedExecution) throw new Error('Anonymization execution changed before database commit');

    const [approval] = await tx.select().from(athleteAnonymizationApprovals).where(and(
      eq(athleteAnonymizationApprovals.id, lockedExecution.approvalId),
      eq(athleteAnonymizationApprovals.tenantId, tenantId),
      eq(athleteAnonymizationApprovals.athleteId, athleteId),
    )).limit(1);
    if (!approval || approval.policyVersion !== ANONYMIZATION_POLICY_VERSION) {
      throw new Error('Current anonymization policy approval required');
    }

    const [athlete] = await tx.select().from(athletes).where(and(
      eq(athletes.id, athleteId),
      eq(athletes.tenantId, tenantId),
    )).limit(1);
    if (!athlete || !athlete.deletedAt || !athlete.consentBlockedAt) {
      throw new Error('Soft-deleted and blocked athlete required for irreversible commit');
    }

    const [deletionRequest] = await tx.select().from(athleteDeletionRequests).where(and(
      eq(athleteDeletionRequests.id, approval.deletionRequestId),
      eq(athleteDeletionRequests.tenantId, tenantId),
      eq(athleteDeletionRequests.athleteId, athleteId),
      eq(athleteDeletionRequests.status, 'COMPLETED'),
    )).limit(1);
    if (!deletionRequest) throw new Error('Completed deletion request changed before database commit');

    const manifest = await tx.select({
      kind: athleteAnonymizationExecutionArtifacts.kind,
      storageReference: athleteAnonymizationExecutionArtifacts.storageReference,
    }).from(athleteAnonymizationExecutionArtifacts).where(and(
      eq(athleteAnonymizationExecutionArtifacts.tenantId, tenantId),
      eq(athleteAnonymizationExecutionArtifacts.executionId, executionId),
    ));
    const reportManifest = manifest.filter((item) => item.kind === 'REPORT').map((item) => item.storageReference);
    const exportManifest = manifest.filter((item) => item.kind === 'TENANT_EXPORT').map((item) => item.storageReference);

    const currentReports = await tx.select({ storageReference: reportVersions.storageReference })
      .from(reportVersions)
      .innerJoin(tests, and(
        eq(tests.id, reportVersions.testId),
        eq(tests.tenantId, tenantId),
        eq(tests.athleteId, athleteId),
      ))
      .where(eq(reportVersions.tenantId, tenantId));
    if (!sameStrings(currentReports.map((item) => item.storageReference), reportManifest)) {
      throw new Error('Report artifact manifest no longer matches database scope');
    }

    const currentActiveExports = await tx.select({ storageReference: tenantExportPackages.storageReference })
      .from(tenantExportPackages)
      .where(and(
        eq(tenantExportPackages.tenantId, tenantId),
        gt(tenantExportPackages.expiresAt, committedAt),
      ));
    if (currentActiveExports.some((item) => !exportManifest.includes(item.storageReference))) {
      throw new Error('Active tenant export appeared after anonymization preparation');
    }
    if (exportManifest.length > 0) {
      const manifestExportRows = await tx.select({ storageReference: tenantExportPackages.storageReference })
        .from(tenantExportPackages)
        .where(and(
          eq(tenantExportPackages.tenantId, tenantId),
          inArray(tenantExportPackages.storageReference, exportManifest),
        ));
      if (!sameStrings(manifestExportRows.map((item) => item.storageReference), exportManifest)) {
        throw new Error('Tenant export artifact manifest source rows changed before database commit');
      }
    }

    for (const candidate of auditInventory.candidates) {
      await applyHistoricalAuditPrivacyRedactionInTransaction(
        tx,
        tenantId,
        athleteId,
        actor,
        candidate,
        maintenanceReference,
        committedAt,
      );
    }

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
      if (interpretationIds.length > 0) {
        removed.zoneProfiles = await deletedCount(tx.delete(zoneProfiles).where(and(
          eq(zoneProfiles.tenantId, tenantId), inArray(zoneProfiles.interpretationId, interpretationIds),
        )).returning({ id: zoneProfiles.id }));
      } else removed.zoneProfiles = 0;
      removed.interpretations = await deletedCount(tx.delete(interpretations).where(and(
        eq(interpretations.tenantId, tenantId), inArray(interpretations.testId, testIds),
      )).returning({ id: interpretations.id }));

      if (thresholdRunIds.length > 0) {
        removed.thresholdResults = await deletedCount(tx.delete(thresholdResults).where(and(
          eq(thresholdResults.tenantId, tenantId), inArray(thresholdResults.thresholdRunId, thresholdRunIds),
        )).returning({ id: thresholdResults.id }));
      } else removed.thresholdResults = 0;
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

    if (exportManifest.length > 0) {
      removed.tenantExportPackages = await deletedCount(tx.delete(tenantExportPackages).where(and(
        eq(tenantExportPackages.tenantId, tenantId),
        inArray(tenantExportPackages.storageReference, exportManifest),
      )).returning({ id: tenantExportPackages.id }));
    } else removed.tenantExportPackages = 0;

    await tx.update(athleteDeletionRequests).set({
      reason: AUDIT_PRIVACY_REDACTED_TEXT,
      decisionReason: AUDIT_PRIVACY_REDACTED_TEXT,
      updatedAt: committedAt,
    }).where(and(
      eq(athleteDeletionRequests.tenantId, tenantId),
      eq(athleteDeletionRequests.athleteId, athleteId),
    ));

    await tx.update(athletes).set({
      ...athleteTombstoneV1(),
      updatedAt: committedAt,
    }).where(and(eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId)));

    await tx.update(athleteAnonymizationExecutions).set({
      status: 'DB_COMMITTED',
      dbCommittedAt: committedAt,
      updatedAt: committedAt,
    }).where(and(
      eq(athleteAnonymizationExecutions.id, executionId),
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      eq(athleteAnonymizationExecutions.status, 'ARTIFACTS_STAGED'),
    ));

    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.anonymization_db_committed',
      entityType: 'athlete_anonymization_execution',
      entityId: executionId,
      source: 'SYSTEM',
      after: {
        athleteId,
        policyVersion: ANONYMIZATION_POLICY_VERSION,
        athleteTombstoneVersion: ATHLETE_TOMBSTONE_VERSION,
        auditEventsRedacted: auditInventory.candidates.length,
        removed,
      },
      occurredAt: committedAt,
    });

    return Object.freeze({
      executionId,
      committedAt,
      auditEventsRedacted: auditInventory.candidates.length,
      removed: Object.freeze({ ...removed }),
      athleteTombstoneVersion: ATHLETE_TOMBSTONE_VERSION,
    });
  });
}
