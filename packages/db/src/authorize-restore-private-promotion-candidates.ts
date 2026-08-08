import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import type { RestorePrivatePromotionActiveVolumeSet } from './services/restore-private-promotion-execution-plan';
import { verifyRestorePrivatePromotionCandidatePlanFromReadiness } from './services/restore-private-promotion-candidate-plan';
import {
  assessRestorePrivatePromotionReadinessFromStorage,
  restorePrivatePromotionStoragePathsFromEnvironment,
} from './services/restore-private-promotion-storage';

const MODE = 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_PREPARATION' as const;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function requireAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requireDockerVolumeName(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${name} is not a safe Docker volume name`);
  return value;
}

function activeVolumesFromEnvironment(): Readonly<RestorePrivatePromotionActiveVolumeSet> {
  return Object.freeze({
    libsql: requireDockerVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_LIBSQL_VOLUME'),
    reports: requireDockerVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_REPORTS_VOLUME'),
    tenantExports: requireDockerVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_TENANT_EXPORTS_VOLUME'),
    dataSubjectDelivery: requireDockerVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_DATA_SUBJECT_DELIVERY_VOLUME'),
  });
}

async function main(): Promise<void> {
  const readiness = await assessRestorePrivatePromotionReadinessFromStorage(
    createDatabase(),
    restorePrivatePromotionStoragePathsFromEnvironment(),
  );
  if (!readiness.promotionAllowed || readiness.status !== 'PROMOTION_READY') {
    process.stdout.write(`${JSON.stringify({
      mode: MODE,
      status: 'BLOCKED',
      candidateMutationAllowed: false,
      productionMutationAllowed: false,
      promotionExecuted: false,
      readiness,
    })}\n`);
    process.exitCode = 3;
    return;
  }

  const verified = await verifyRestorePrivatePromotionCandidatePlanFromReadiness(readiness, {
    promotionIntentFile: requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_FILE'),
    promotionKeyFile: requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE'),
    executionPlanFile: requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE'),
    activeVolumes: activeVolumesFromEnvironment(),
  });

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'CANDIDATE_COPY_AUTHORIZED',
    evidenceRecomputed: true,
    candidateMutationAllowed: true,
    productionMutationAllowed: false,
    promotionExecuted: false,
    backupCutoff: verified.plan.record.backupCutoff,
    executionFingerprint: verified.preflight.executionFingerprint,
    planFingerprint: verified.plan.record.planFingerprint,
    planSignature: verified.plan.signature,
    candidateSetId: verified.plan.record.candidateSetId,
    activeVolumeSetFingerprint: verified.plan.record.activeVolumeSetFingerprint,
    volumes: verified.plan.record.volumes,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion candidate preparation authorization failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
