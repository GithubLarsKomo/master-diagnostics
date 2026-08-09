import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  ensureSignedRestorePrivatePromotionSwitchIntent,
  type RestorePrivatePromotionCandidateSetHealthcheck,
} from './services/restore-private-promotion-switch-intent';

const MODE = 'ISOLATED_RESTORE_PROMOTION_SWITCH_INTENT' as const;

function requireAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function readHealthcheck(filePath: string): Promise<Readonly<RestorePrivatePromotionCandidateSetHealthcheck>> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion candidate healthcheck must be a regular non-symlink file');
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as RestorePrivatePromotionCandidateSetHealthcheck;
  } catch (error) {
    throw new Error('Restore promotion candidate healthcheck is not valid JSON', { cause: error });
  }
}

async function main(): Promise<void> {
  const healthcheckFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_CANDIDATE_HEALTHCHECK_FILE');
  const promotionDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_DIR');
  const promotionKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const healthcheck = await readHealthcheck(healthcheckFile);
  const intent = await ensureSignedRestorePrivatePromotionSwitchIntent({
    targetDir: promotionDir,
    keyFile: promotionKeyFile,
    healthcheck,
    authorizedAt: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'SWITCH_AUTHORIZED',
    productionSwitchAuthorized: true,
    productionMutationApplied: false,
    promotionExecuted: false,
    intentCreated: intent.created,
    intentReused: !intent.created,
    authorizedAt: intent.envelope.record.authorizedAt,
    candidateSetFingerprint: intent.envelope.record.candidateSetFingerprint,
    planFingerprint: intent.envelope.record.planFingerprint,
    activeVolumeSetFingerprint: intent.envelope.record.activeVolumeSetFingerprint,
    candidateSetId: intent.envelope.record.candidateSetId,
    selectorStrategy: intent.envelope.record.selectorStrategy,
    crashRecoveryPolicy: intent.envelope.record.crashRecoveryPolicy,
    rollbackPolicy: intent.envelope.record.rollbackPolicy,
    completionPolicy: intent.envelope.record.completionPolicy,
    switchIntentSignature: intent.envelope.signature,
    volumes: intent.envelope.record.volumes,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion switch authorization failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
