import { createHash } from 'node:crypto';
import { and, asc, eq, gte } from 'drizzle-orm';
import type { Database } from '../client';
import { auditEvents } from '../schema';
import {
  type RestorePrivacyArtifactReplayResult,
  type RestorePrivacyArtifactReplayRoots,
} from './restore-privacy-artifact-replay';
import {
  restorePrivacyObligationsFingerprint,
  type RestorePrivacyArtifactReplayManifest,
} from './restore-privacy-artifact-replay-manifest';
import {
  assessRestorePrivateHealthcheck,
  type RestorePrivateHealthcheckReport,
} from './restore-private-healthcheck';
import type { RestorePrivateRecoveryPlan } from './restore-private-recovery-plan';
import { verifyRestorePrivateRecoveryPlan } from './restore-private-recovery-plan';
import { readVerifiedRestorePrivateRecoveryReceipt } from './restore-private-recovery-receipt';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVATE_PROMOTION_READINESS_VERSION = 1 as const;

export type RestorePrivatePromotionReadinessStatus = 'PROMOTION_READY' | 'BLOCKED';
export type RestorePrivatePromotionRecoveryEvidenceStatus = 'NOT_REQUIRED' | 'VERIFIED' | 'MISSING' | 'INVALID';

export type RestorePrivatePromotionReadinessBlockerCode =
  | 'HEALTHCHECK_NOT_HEALTHY'
  | 'RECONCILIATION_NOT_READY'
  | 'DATABASE_REPLAY_NOT_SATISFIED'
  | 'ARTIFACT_REPLAY_NOT_VERIFIED'
  | 'RECOVERY_EVIDENCE_REQUIRED'
  | 'RECOVERY_EVIDENCE_UNEXPECTED'
  | 'RECOVERY_EVIDENCE_INCOMPLETE'
  | 'RECOVERY_EVIDENCE_INVALID';

export interface RestorePrivatePromotionReadinessBlocker {
  readonly code: RestorePrivatePromotionReadinessBlockerCode;
  readonly executionId: string | null;
}

export interface RestorePrivatePromotionRecoveryEvidenceInput {
  readonly plan: Readonly<RestorePrivateRecoveryPlan> | null;
  readonly intentFile: string | null;
  readonly receiptFile: string | null;
  readonly keyFile: string | null;
}

export interface RestorePrivatePromotionReadinessReport {
  readonly readinessVersion: typeof RESTORE_PRIVATE_PROMOTION_READINESS_VERSION;
  readonly backupCutoff: string;
  readonly status: RestorePrivatePromotionReadinessStatus;
  readonly promotionAllowed: boolean;
  readonly authorizationScope: 'PRIVATE_RESTORE_PROMOTION';
  readonly reconciliationStatus: RestorePrivacyReconciliationReport['status'];
  readonly obligationsFingerprint: `sha256:${string}`;
  readonly artifactEntriesFingerprint: `sha256:${string}` | null;
  readonly healthcheckFingerprint: `sha256:${string}`;
  readonly recoveryEvidenceStatus: RestorePrivatePromotionRecoveryEvidenceStatus;
  readonly recoveryPlanFingerprint: `sha256:${string}` | null;
  readonly recoveryIntentSignature: `hmac-sha256:${string}` | null;
  readonly recoveryReceiptSignature: `hmac-sha256:${string}` | null;
  readonly recoveryCompletedAt: string | null;
  readonly evidenceFingerprint: `sha256:${string}`;
  readonly healthcheck: Readonly<RestorePrivateHealthcheckReport>;
  readonly blockers: readonly Readonly<RestorePrivatePromotionReadinessBlocker>[];
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function blocker(
  code: RestorePrivatePromotionReadinessBlockerCode,
  executionId: string | null = null,
): Readonly<RestorePrivatePromotionReadinessBlocker> {
  return Object.freeze({ code, executionId });
}

function blockerKey(item: Readonly<RestorePrivatePromotionReadinessBlocker>): string {
  return `${item.code}\n${item.executionId ?? ''}`;
}

function recoveryInputState(input: Readonly<RestorePrivatePromotionRecoveryEvidenceInput>) {
  const values = [input.plan, input.intentFile, input.receiptFile, input.keyFile];
  const presentCount = values.filter((value) => value !== null).length;
  return Object.freeze({ presentCount, complete: presentCount === values.length, absent: presentCount === 0 });
}

function expectedAuditAction(action: RestorePrivateRecoveryPlan['actions'][number]['action']): string | null {
  if (action === 'ABORT_PREPARING' || action === 'RESTORE_ARTIFACTS_AND_ABORT') {
    return 'restore.anonymization_execution_aborted';
  }
  if (action === 'PURGE_ARTIFACTS_AND_COMPLETE') return 'restore.anonymization_execution_completed';
  return null;
}

function canonicalHealthcheck(report: Readonly<RestorePrivateHealthcheckReport>) {
  return {
    healthcheckVersion: report.healthcheckVersion,
    backupCutoff: report.backupCutoff,
    status: report.status,
    healthcheckPassed: report.healthcheckPassed,
    readyForPromotionReview: report.readyForPromotionReview,
    promotionAllowed: report.promotionAllowed,
    reconciliationStatus: report.reconciliationStatus,
    databaseStatus: report.databaseStatus,
    artifactManifestVerified: report.artifactManifestVerified,
    artifactReplayVerified: report.artifactReplayVerified,
    storage: report.storage,
    transientExecutions: report.transientExecutions,
    normalizedTransientExecutions: report.normalizedTransientExecutions,
    blockers: report.blockers,
  };
}

/**
 * Read-only final authorization assessment for a private restore workspace.
 *
 * This function performs no promotion and writes no evidence. `promotionAllowed=true` means only
 * that a later promotion executor may consume this exact evidence set. Any change to reconciliation,
 * replay state, recovery evidence or the freshly recomputed healthcheck requires a new assessment.
 */
export async function assessRestorePrivatePromotionReadiness(
  db: Database,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  artifactManifest: Readonly<RestorePrivacyArtifactReplayManifest> | null,
  artifactResult: Readonly<RestorePrivacyArtifactReplayResult> | null,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  recoveryEvidence: Readonly<RestorePrivatePromotionRecoveryEvidenceInput>,
): Promise<Readonly<RestorePrivatePromotionReadinessReport>> {
  const blockers: RestorePrivatePromotionReadinessBlocker[] = [];
  const healthcheck = await assessRestorePrivateHealthcheck(
    db,
    reconciliation,
    artifactManifest,
    artifactResult,
    roots,
  );

  if (!healthcheck.healthcheckPassed || healthcheck.status !== 'HEALTHY' || !healthcheck.readyForPromotionReview) {
    blockers.push(blocker('HEALTHCHECK_NOT_HEALTHY'));
  }
  if (reconciliation.status === 'BLOCKED' || !reconciliation.reconciliationReady) {
    blockers.push(blocker('RECONCILIATION_NOT_READY'));
  }
  if (healthcheck.databaseStatus !== 'DATABASE_SATISFIED') {
    blockers.push(blocker('DATABASE_REPLAY_NOT_SATISFIED'));
  }
  if (!healthcheck.artifactManifestVerified || !healthcheck.artifactReplayVerified) {
    blockers.push(blocker('ARTIFACT_REPLAY_NOT_VERIFIED'));
  }

  const currentRecoveryAudits = await db.select({
    executionId: auditEvents.entityId,
    action: auditEvents.action,
    correlationId: auditEvents.correlationId,
    occurredAt: auditEvents.occurredAt,
  }).from(auditEvents).where(and(
    eq(auditEvents.source, 'RESTORE_RECOVERY'),
    gte(auditEvents.occurredAt, reconciliation.backupCutoff),
  )).orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));

  const recoveryDetected = currentRecoveryAudits.length > 0
    || healthcheck.normalizedTransientExecutions.length > 0;
  const inputState = recoveryInputState(recoveryEvidence);
  let recoveryEvidenceStatus: RestorePrivatePromotionRecoveryEvidenceStatus = 'NOT_REQUIRED';
  let recoveryPlanFingerprint: `sha256:${string}` | null = null;
  let recoveryIntentSignature: `hmac-sha256:${string}` | null = null;
  let recoveryReceiptSignature: `hmac-sha256:${string}` | null = null;
  let recoveryCompletedAt: string | null = null;

  if (!inputState.absent && !inputState.complete) {
    recoveryEvidenceStatus = 'INVALID';
    blockers.push(blocker('RECOVERY_EVIDENCE_INCOMPLETE'));
  } else if (recoveryDetected && inputState.absent) {
    recoveryEvidenceStatus = 'MISSING';
    blockers.push(blocker('RECOVERY_EVIDENCE_REQUIRED'));
  } else if (!recoveryDetected && inputState.complete) {
    recoveryEvidenceStatus = 'INVALID';
    blockers.push(blocker('RECOVERY_EVIDENCE_UNEXPECTED'));
  } else if (inputState.complete) {
    const plan = recoveryEvidence.plan!;
    const intentFile = recoveryEvidence.intentFile!;
    const receiptFile = recoveryEvidence.receiptFile!;
    const keyFile = recoveryEvidence.keyFile!;
    try {
      verifyRestorePrivateRecoveryPlan(plan, reconciliation);
      const receipt = await readVerifiedRestorePrivateRecoveryReceipt(
        receiptFile,
        keyFile,
        intentFile,
        plan,
        reconciliation,
      );

      const expectedAudits = plan.actions
        .map((action) => ({
          executionId: action.executionId,
          action: expectedAuditAction(action.action),
        }))
        .filter((item): item is { executionId: string; action: string } => item.action !== null)
        .sort((left, right) => `${left.executionId}\n${left.action}`.localeCompare(`${right.executionId}\n${right.action}`));
      const actualAudits = currentRecoveryAudits
        .map((item) => ({ executionId: item.executionId, action: item.action, correlationId: item.correlationId }))
        .sort((left, right) => `${left.executionId ?? ''}\n${left.action}`.localeCompare(`${right.executionId ?? ''}\n${right.action}`));

      if (
        actualAudits.length !== expectedAudits.length
        || actualAudits.some((item, index) => {
          const expected = expectedAudits[index];
          return !expected
            || item.executionId !== expected.executionId
            || item.action !== expected.action
            || item.correlationId !== plan.planFingerprint;
        })
      ) {
        throw new Error('Restore recovery audit evidence does not match the verified recovery plan');
      }

      const expectedNormalizations = plan.actions
        .filter((action) => action.action === 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE')
        .map((action) => action.executionId)
        .sort();
      const actualNormalizations = healthcheck.normalizedTransientExecutions
        .filter((item) => item.planFingerprint === plan.planFingerprint)
        .map((item) => item.executionId)
        .sort();
      if (JSON.stringify(actualNormalizations) !== JSON.stringify(expectedNormalizations)) {
        throw new Error('Restore recovery normalization evidence does not match the verified recovery plan');
      }

      recoveryEvidenceStatus = 'VERIFIED';
      recoveryPlanFingerprint = plan.planFingerprint;
      recoveryIntentSignature = receipt.record.intentSignature;
      recoveryReceiptSignature = receipt.signature;
      recoveryCompletedAt = receipt.record.recoveryCompletedAt;
    } catch {
      recoveryEvidenceStatus = 'INVALID';
      blockers.push(blocker('RECOVERY_EVIDENCE_INVALID'));
    }
  }

  const canonicalBlockers = Object.freeze(
    [...new Map(blockers.map((item) => [blockerKey(item), item] as const)).values()]
      .sort((left, right) => blockerKey(left).localeCompare(blockerKey(right))),
  );
  const healthcheckFingerprint = sha256(JSON.stringify(canonicalHealthcheck(healthcheck)));
  const obligationsFingerprint = restorePrivacyObligationsFingerprint(reconciliation.obligations);
  const promotionAllowed = canonicalBlockers.length === 0;
  const evidenceBody = {
    readinessVersion: RESTORE_PRIVATE_PROMOTION_READINESS_VERSION,
    backupCutoff: reconciliation.backupCutoff,
    reconciliationStatus: reconciliation.status,
    ledgerGeneratedAt: reconciliation.ledger?.generatedAt ?? null,
    ledgerEntriesFingerprint: reconciliation.ledger?.entriesFingerprint ?? null,
    journalMarkerCount: reconciliation.journalMarkerCount,
    obligationsFingerprint,
    artifactManifestVersion: artifactManifest?.manifestVersion ?? null,
    artifactEntriesFingerprint: artifactManifest?.entriesFingerprint ?? null,
    artifactResultVersion: artifactResult?.resultVersion ?? null,
    artifactVerifiedAbsentCount: artifactResult?.verifiedAbsentCount ?? null,
    healthcheckFingerprint,
    recoveryEvidenceStatus,
    recoveryPlanFingerprint,
    recoveryIntentSignature,
    recoveryReceiptSignature,
    recoveryCompletedAt,
    promotionAllowed,
  };

  return Object.freeze({
    readinessVersion: RESTORE_PRIVATE_PROMOTION_READINESS_VERSION,
    backupCutoff: reconciliation.backupCutoff,
    status: promotionAllowed ? 'PROMOTION_READY' : 'BLOCKED',
    promotionAllowed,
    authorizationScope: 'PRIVATE_RESTORE_PROMOTION',
    reconciliationStatus: reconciliation.status,
    obligationsFingerprint,
    artifactEntriesFingerprint: artifactManifest?.entriesFingerprint ?? null,
    healthcheckFingerprint,
    recoveryEvidenceStatus,
    recoveryPlanFingerprint,
    recoveryIntentSignature,
    recoveryReceiptSignature,
    recoveryCompletedAt,
    evidenceFingerprint: sha256(JSON.stringify(evidenceBody)),
    healthcheck,
    blockers: canonicalBlockers,
  });
}
