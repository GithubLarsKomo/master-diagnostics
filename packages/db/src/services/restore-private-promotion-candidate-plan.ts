import type { Database } from '../client';
import {
  readVerifiedRestorePrivatePromotionExecutionPlan,
  type RestorePrivatePromotionActiveVolumeSet,
  type SignedRestorePrivatePromotionExecutionPlanEnvelope,
} from './restore-private-promotion-execution-plan';
import {
  assessRestorePrivatePromotionExecutionPreflight,
  type RestorePrivatePromotionExecutionPreflight,
} from './restore-private-promotion-execution-preflight';
import type { RestorePrivatePromotionReadinessReport } from './restore-private-promotion-readiness';
import {
  assessRestorePrivatePromotionReadinessFromStorage,
  type RestorePrivatePromotionStoragePaths,
} from './restore-private-promotion-storage';

export interface RestorePrivatePromotionCandidatePlanBindingInput {
  readonly promotionIntentFile: string;
  readonly promotionKeyFile: string;
  readonly executionPlanFile: string;
  readonly activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>;
}

export interface RestorePrivatePromotionCandidatePlanInput
  extends RestorePrivatePromotionCandidatePlanBindingInput {
  readonly storagePaths: Readonly<RestorePrivatePromotionStoragePaths>;
}

export interface VerifiedRestorePrivatePromotionCandidatePlan {
  readonly readiness: Readonly<RestorePrivatePromotionReadinessReport>;
  readonly preflight: Readonly<RestorePrivatePromotionExecutionPreflight>;
  readonly plan: Readonly<SignedRestorePrivatePromotionExecutionPlanEnvelope>;
}

/** Bind an already freshly recomputed readiness report to intent, preflight, plan and active volumes. */
export async function verifyRestorePrivatePromotionCandidatePlanFromReadiness(
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
  input: Readonly<RestorePrivatePromotionCandidatePlanBindingInput>,
): Promise<Readonly<VerifiedRestorePrivatePromotionCandidatePlan>> {
  if (!readiness.promotionAllowed || readiness.status !== 'PROMOTION_READY') {
    throw new Error('Restore promotion candidate plan requires fresh PROMOTION_READY evidence');
  }
  const preflight = await assessRestorePrivatePromotionExecutionPreflight(
    readiness,
    input.promotionIntentFile,
    input.promotionKeyFile,
  );
  const plan = await readVerifiedRestorePrivatePromotionExecutionPlan(
    input.executionPlanFile,
    input.promotionKeyFile,
    preflight,
    input.activeVolumes,
  );
  return Object.freeze({ readiness, preflight, plan });
}

/**
 * Reconstructs and verifies the complete promotion chain used both by candidate mutation
 * authorization and the later read-only candidate-set healthcheck.
 */
export async function verifyRestorePrivatePromotionCandidatePlan(
  db: Database,
  input: Readonly<RestorePrivatePromotionCandidatePlanInput>,
): Promise<Readonly<VerifiedRestorePrivatePromotionCandidatePlan>> {
  const readiness = await assessRestorePrivatePromotionReadinessFromStorage(db, input.storagePaths);
  return verifyRestorePrivatePromotionCandidatePlanFromReadiness(readiness, input);
}
