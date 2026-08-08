import { and, count, eq, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Database } from '../client';
import {
  athleteDataSubjectDeliveryPackages,
  athleteDeletionRequests,
  athleteGuardians,
  athleteSnapshots,
  athletes,
  auditEvents,
  coachAthleteAssignments,
  tenantExportPackages,
  tests,
} from '../schema';
import { AUDIT_PRIVACY_REDACTED_TEXT } from './audit-privacy-redaction';
import { athleteTombstoneV1 } from './anonymization-tombstone';
import type {
  RestorePrivacyReconciliationReport,
  RestorePrivacyReplayObligation,
} from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVACY_REPLAY_ASSESSMENT_VERSION = 1 as const;

export type RestorePrivacyReplayDatabaseStatus =
  | 'BLOCKED'
  | 'DATABASE_REPLAY_REQUIRED'
  | 'DATABASE_SATISFIED';

export type RestorePrivacyReplayDatabaseReason =
  | 'ATHLETE_STATE_UNRESOLVED'
  | 'ATHLETE_TOMBSTONE_MISSING'
  | 'TEST_DATA_REMAINS'
  | 'ATHLETE_SNAPSHOT_REMAINS'
  | 'COACH_ASSIGNMENT_REMAINS'
  | 'GUARDIAN_REMAINS'
  | 'DATA_SUBJECT_EXPORT_METADATA_REMAINS'
  | 'TENANT_EXPORT_METADATA_REMAINS'
  | 'DELETION_REQUEST_TEXT_NOT_REDACTED'
  | 'COMMIT_PROOF_MISSING';

export interface RestorePrivacyReplayDatabaseCounts {
  readonly tests: number;
  readonly athleteSnapshots: number;
  readonly coachAssignments: number;
  readonly guardians: number;
  readonly dataSubjectExportPackages: number;
  readonly tenantExportPackages: number;
  readonly deletionRequestsWithUnredactedText: number;
  readonly matchingCommitProofs: number;
}

export interface RestorePrivacyReplayDatabaseObligationAssessment {
  readonly executionId: string;
  readonly tenantId: string;
  readonly athleteId: string;
  readonly status: RestorePrivacyReplayDatabaseStatus;
  readonly reasons: readonly RestorePrivacyReplayDatabaseReason[];
  readonly counts: Readonly<RestorePrivacyReplayDatabaseCounts> | null;
}

export interface RestorePrivacyReplayDatabaseAssessment {
  readonly assessmentVersion: typeof RESTORE_PRIVACY_REPLAY_ASSESSMENT_VERSION;
  readonly backupCutoff: string;
  readonly status: RestorePrivacyReplayDatabaseStatus;
  readonly promotionAllowed: false;
  readonly artifactVerificationRequired: boolean;
  readonly obligations: readonly Readonly<RestorePrivacyReplayDatabaseObligationAssessment>[];
}

async function scalarCount(
  db: Database,
  table: SQLiteTable,
  where: SQL | undefined,
): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table).where(where);
  return row?.value ?? 0;
}

function tombstoneMatches(row: typeof athletes.$inferSelect): boolean {
  const expected = athleteTombstoneV1();
  return row.linkedUserId === expected.linkedUserId
    && row.firstName === expected.firstName
    && row.lastName === expected.lastName
    && row.birthDate === expected.birthDate
    && row.referenceCategory === expected.referenceCategory
    && row.heightCm === expected.heightCm
    && row.currentWeightKgX100 === expected.currentWeightKgX100
    && row.primarySport === expected.primarySport
    && row.primaryDiscipline === expected.primaryDiscipline
    && row.trainingStatus === expected.trainingStatus;
}

async function assessObligation(
  db: Database,
  obligation: Readonly<RestorePrivacyReplayObligation>,
): Promise<Readonly<RestorePrivacyReplayDatabaseObligationAssessment>> {
  const [athlete] = await db.select().from(athletes).where(and(
    eq(athletes.id, obligation.athleteId),
    eq(athletes.tenantId, obligation.tenantId),
  )).limit(1);

  if (!athlete) {
    return Object.freeze({
      executionId: obligation.executionId,
      tenantId: obligation.tenantId,
      athleteId: obligation.athleteId,
      status: 'BLOCKED',
      reasons: Object.freeze(['ATHLETE_STATE_UNRESOLVED'] as const),
      counts: null,
    });
  }

  const [
    testCount,
    snapshotCount,
    coachAssignmentCount,
    guardianCount,
    subjectExportCount,
    tenantExportCount,
    deletionRequests,
    commitProofCount,
  ] = await Promise.all([
    scalarCount(db, tests, and(eq(tests.tenantId, obligation.tenantId), eq(tests.athleteId, obligation.athleteId))),
    scalarCount(db, athleteSnapshots, and(
      eq(athleteSnapshots.tenantId, obligation.tenantId),
      eq(athleteSnapshots.athleteId, obligation.athleteId),
    )),
    scalarCount(db, coachAthleteAssignments, and(
      eq(coachAthleteAssignments.tenantId, obligation.tenantId),
      eq(coachAthleteAssignments.athleteId, obligation.athleteId),
    )),
    scalarCount(db, athleteGuardians, and(
      eq(athleteGuardians.tenantId, obligation.tenantId),
      eq(athleteGuardians.athleteId, obligation.athleteId),
    )),
    scalarCount(db, athleteDataSubjectDeliveryPackages, and(
      eq(athleteDataSubjectDeliveryPackages.tenantId, obligation.tenantId),
      eq(athleteDataSubjectDeliveryPackages.athleteId, obligation.athleteId),
    )),
    scalarCount(db, tenantExportPackages, eq(tenantExportPackages.tenantId, obligation.tenantId)),
    db.select({ reason: athleteDeletionRequests.reason, decisionReason: athleteDeletionRequests.decisionReason })
      .from(athleteDeletionRequests)
      .where(and(
        eq(athleteDeletionRequests.tenantId, obligation.tenantId),
        eq(athleteDeletionRequests.athleteId, obligation.athleteId),
      )),
    scalarCount(db, auditEvents, and(
      eq(auditEvents.tenantId, obligation.tenantId),
      eq(auditEvents.action, 'athlete.anonymization_db_committed'),
      eq(auditEvents.entityType, 'athlete_anonymization_execution'),
      eq(auditEvents.entityId, obligation.executionId),
    )),
  ]);

  const unredactedDeletionRequestCount = deletionRequests.filter((row) => (
    row.reason !== AUDIT_PRIVACY_REDACTED_TEXT
      || row.decisionReason !== AUDIT_PRIVACY_REDACTED_TEXT
  )).length;

  const counts = Object.freeze({
    tests: testCount,
    athleteSnapshots: snapshotCount,
    coachAssignments: coachAssignmentCount,
    guardians: guardianCount,
    dataSubjectExportPackages: subjectExportCount,
    tenantExportPackages: tenantExportCount,
    deletionRequestsWithUnredactedText: unredactedDeletionRequestCount,
    matchingCommitProofs: commitProofCount,
  });

  const reasons: RestorePrivacyReplayDatabaseReason[] = [];
  if (!tombstoneMatches(athlete)) reasons.push('ATHLETE_TOMBSTONE_MISSING');
  if (testCount > 0) reasons.push('TEST_DATA_REMAINS');
  if (snapshotCount > 0) reasons.push('ATHLETE_SNAPSHOT_REMAINS');
  if (coachAssignmentCount > 0) reasons.push('COACH_ASSIGNMENT_REMAINS');
  if (guardianCount > 0) reasons.push('GUARDIAN_REMAINS');
  if (subjectExportCount > 0) reasons.push('DATA_SUBJECT_EXPORT_METADATA_REMAINS');
  if (tenantExportCount > 0) reasons.push('TENANT_EXPORT_METADATA_REMAINS');
  if (unredactedDeletionRequestCount > 0) reasons.push('DELETION_REQUEST_TEXT_NOT_REDACTED');
  if (commitProofCount < 1) reasons.push('COMMIT_PROOF_MISSING');

  return Object.freeze({
    executionId: obligation.executionId,
    tenantId: obligation.tenantId,
    athleteId: obligation.athleteId,
    status: reasons.length === 0 ? 'DATABASE_SATISFIED' : 'DATABASE_REPLAY_REQUIRED',
    reasons: Object.freeze(reasons),
    counts,
  });
}

/**
 * Assesses only the database half of restore privacy replay.
 *
 * The caller must connect this service exclusively to an isolated restore-staging database or a
 * private copy of it. This function is read-only and intentionally does not claim that filesystem
 * artifacts are safe; `promotionAllowed` therefore remains false even when the database state is
 * already satisfied.
 */
export async function assessRestorePrivacyReplayDatabase(
  db: Database,
  report: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<RestorePrivacyReplayDatabaseAssessment>> {
  if (report.status === 'BLOCKED' || !report.reconciliationReady) {
    return Object.freeze({
      assessmentVersion: RESTORE_PRIVACY_REPLAY_ASSESSMENT_VERSION,
      backupCutoff: report.backupCutoff,
      status: 'BLOCKED',
      promotionAllowed: false,
      artifactVerificationRequired: report.obligations.length > 0,
      obligations: Object.freeze([]),
    });
  }

  const obligations = Object.freeze(await Promise.all(
    report.obligations.map((obligation) => assessObligation(db, obligation)),
  ));
  const status: RestorePrivacyReplayDatabaseStatus = obligations.some((item) => item.status === 'BLOCKED')
    ? 'BLOCKED'
    : obligations.some((item) => item.status === 'DATABASE_REPLAY_REQUIRED')
      ? 'DATABASE_REPLAY_REQUIRED'
      : 'DATABASE_SATISFIED';

  return Object.freeze({
    assessmentVersion: RESTORE_PRIVACY_REPLAY_ASSESSMENT_VERSION,
    backupCutoff: report.backupCutoff,
    status,
    promotionAllowed: false,
    artifactVerificationRequired: report.obligations.length > 0,
    obligations,
  });
}
