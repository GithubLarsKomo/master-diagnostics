import type { Database } from '../client';
import type {
  RestorePrivacyArtifactReplayResult,
  RestorePrivacyArtifactReplayRoots,
} from './restore-privacy-artifact-replay';
import type { RestorePrivacyArtifactReplayManifest } from './restore-privacy-artifact-replay-manifest';
import {
  assessRestorePrivateHealthcheck,
  type RestorePrivateHealthcheckReport,
} from './restore-private-healthcheck';
import {
  assessRestorePrivateRecovery,
  type RestorePrivateRecoveryAssessment,
} from './restore-private-recovery-assessment';
import {
  buildRestorePrivateRecoveryPlan,
  persistRestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlan,
} from './restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export type RestorePrivateRecoveryPlanningStatus = 'NOT_REQUIRED' | 'PLAN_READY' | 'BLOCKED';

export interface RestorePrivateRecoveryPlanningResult {
  readonly status: RestorePrivateRecoveryPlanningStatus;
  readonly promotionAllowed: false;
  readonly healthcheck: Readonly<RestorePrivateHealthcheckReport>;
  readonly assessment: Readonly<RestorePrivateRecoveryAssessment>;
  readonly planCreated: boolean;
  readonly plan: Readonly<RestorePrivateRecoveryPlan> | null;
}

/**
 * Runs the complete read-only recovery decision chain against the private restore copy and only
 * persists a durable plan when the assessment is unambiguously RECOVERY_READY.
 *
 * This function performs no recovery mutation. The only write is the exclusive/idempotent plan
 * evidence file produced after all read-only checks have succeeded.
 */
export async function prepareRestorePrivateRecoveryPlan(
  db: Database,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  artifactManifest: Readonly<RestorePrivacyArtifactReplayManifest> | null,
  artifactResult: Readonly<RestorePrivacyArtifactReplayResult> | null,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  planFile: string,
): Promise<Readonly<RestorePrivateRecoveryPlanningResult>> {
  const healthcheck = await assessRestorePrivateHealthcheck(
    db,
    reconciliation,
    artifactManifest,
    artifactResult,
    roots,
  );
  const assessment = await assessRestorePrivateRecovery(
    db,
    reconciliation,
    healthcheck,
    roots,
  );

  if (assessment.status === 'BLOCKED') {
    return Object.freeze({
      status: 'BLOCKED',
      promotionAllowed: false,
      healthcheck,
      assessment,
      planCreated: false,
      plan: null,
    });
  }

  if (assessment.status === 'NOT_REQUIRED') {
    return Object.freeze({
      status: 'NOT_REQUIRED',
      promotionAllowed: false,
      healthcheck,
      assessment,
      planCreated: false,
      plan: null,
    });
  }

  const plan = await buildRestorePrivateRecoveryPlan(
    db,
    reconciliation,
    assessment,
    roots,
  );
  const persisted = await persistRestorePrivateRecoveryPlan(planFile, plan);
  return Object.freeze({
    status: 'PLAN_READY',
    promotionAllowed: false,
    healthcheck,
    assessment,
    planCreated: persisted.created,
    plan: persisted.plan,
  });
}
