import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { assessRestorePrivatePromotionExecutionPreflight } from './services/restore-private-promotion-execution-preflight';
import {
  assessRestorePrivatePromotionReadinessFromStorage,
  restorePrivatePromotionStoragePathsFromEnvironment,
} from './services/restore-private-promotion-storage';

const MODE = 'ISOLATED_RESTORE_PROMOTION_EXECUTION_PREFLIGHT' as const;

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
      mode: MODE,
      status: 'BLOCKED',
      promotionAllowed: false,
      authorizationPersisted: false,
      promotionExecuted: false,
      readiness,
    })}\n`);
    process.exitCode = 3;
    return;
  }

  const intentFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_FILE');
  const intentKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const preflight = await assessRestorePrivatePromotionExecutionPreflight(
    readiness,
    intentFile,
    intentKeyFile,
  );

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    ...preflight,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore private promotion execution preflight failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
