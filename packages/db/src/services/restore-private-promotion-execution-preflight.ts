import { createHash } from 'node:crypto';
import {
  readVerifiedRestorePrivatePromotionIntent,
  type SignedRestorePrivatePromotionIntentEnvelope,
} from './restore-private-promotion-intent';
import type { RestorePrivatePromotionReadinessReport } from './restore-private-promotion-readiness';

export const RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION = 1 as const;

export interface RestorePrivatePromotionExecutionPreflight {
  readonly preflightVersion: typeof RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION;
  readonly status: 'EXECUTION_READY';
  readonly authorizationScope: 'PRIVATE_RESTORE_PROMOTION';
  readonly backupCutoff: string;
  readonly readinessEvidenceFingerprint: `sha256:${string}`;
  readonly healthcheckFingerprint: `sha256:${string}`;
  readonly intentSignature: `hmac-sha256:${string}`;
  readonly authorizedAt: string;
  readonly promotionAllowed: true;
  readonly authorizationPersisted: true;
  readonly promotionExecuted: false;
  readonly executionFingerprint: `sha256:${string}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalPreflightBody(
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
  intent: Readonly<SignedRestorePrivatePromotionIntentEnvelope>,
) {
  return {
    preflightVersion: RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION,
    authorizationScope: 'PRIVATE_RESTORE_PROMOTION' as const,
    backupCutoff: readiness.backupCutoff,
    readinessEvidenceFingerprint: readiness.evidenceFingerprint,
    healthcheckFingerprint: readiness.healthcheckFingerprint,
    intentSignature: intent.signature,
    authorizedAt: intent.record.authorizedAt,
    promotionAllowed: true as const,
    authorizationPersisted: true as const,
    promotionExecuted: false as const,
  };
}

/**
 * Re-verifies the durable promotion intent against a freshly reconstructed readiness report.
 * No evidence is written and no production state is touched. A later executor must call this
 * immediately before crossing the downtime / production-mutation boundary.
 */
export async function assessRestorePrivatePromotionExecutionPreflight(
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
  intentFile: string,
  intentKeyFile: string,
): Promise<Readonly<RestorePrivatePromotionExecutionPreflight>> {
  if (
    readiness.status !== 'PROMOTION_READY'
    || readiness.promotionAllowed !== true
    || readiness.authorizationPersisted !== false
    || readiness.blockers.length !== 0
  ) {
    throw new Error('Restore promotion execution preflight requires fresh PROMOTION_READY evidence');
  }

  const intent = await readVerifiedRestorePrivatePromotionIntent(
    intentFile,
    intentKeyFile,
    readiness,
  );
  if (intent.record.promotionExecuted !== false) {
    throw new Error('Restore promotion intent is not eligible for first execution');
  }

  const body = canonicalPreflightBody(readiness, intent);
  return Object.freeze({
    preflightVersion: RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION,
    status: 'EXECUTION_READY',
    ...body,
    executionFingerprint: sha256(JSON.stringify(body)),
  });
}
