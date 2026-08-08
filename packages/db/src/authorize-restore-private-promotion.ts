import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import {
  ensureSignedRestorePrivatePromotionIntent,
} from './services/restore-private-promotion-intent';
import {
  assessRestorePrivatePromotionReadinessFromStorage,
  restorePrivatePromotionStoragePathsFromEnvironment,
} from './services/restore-private-promotion-storage';

const RESTORE_PRIVATE_PROMOTION_INTENT_CLI_MODE = 'ISOLATED_RESTORE_PROMOTION_INTENT' as const;

function requireAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function main(): Promise<void> {
  const readiness = await assessRestorePrivatePromotionReadinessFromStorage(
    createDatabase(),
    restorePrivatePromotionStoragePathsFromEnvironment(),
  );

  if (!readiness.promotionAllowed || readiness.status !== 'PROMOTION_READY') {
    process.stdout.write(`${JSON.stringify({
      mode: RESTORE_PRIVATE_PROMOTION_INTENT_CLI_MODE,
      status: 'BLOCKED',
      promotionAllowed: false,
      authorizationPersisted: false,
      promotionExecuted: false,
      readiness,
    })}\n`);
    process.exitCode = 3;
    return;
  }

  const promotionIntentDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_DIR');
  const promotionKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const intent = await ensureSignedRestorePrivatePromotionIntent({
    targetDir: promotionIntentDir,
    keyFile: promotionKeyFile,
    readiness,
    authorizedAt: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify({
    mode: RESTORE_PRIVATE_PROMOTION_INTENT_CLI_MODE,
    status: 'AUTHORIZED',
    backupCutoff: readiness.backupCutoff,
    promotionAllowed: true,
    authorizationPersisted: true,
    promotionExecuted: false,
    evidenceFingerprint: readiness.evidenceFingerprint,
    intentCreated: intent.created,
    intentReused: !intent.created,
    authorizedAt: intent.envelope.record.authorizedAt,
    intentSignature: intent.envelope.signature,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore private promotion intent authorization failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
