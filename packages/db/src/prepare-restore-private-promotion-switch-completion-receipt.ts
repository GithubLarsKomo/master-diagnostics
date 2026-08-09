import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readAuthenticatedRestorePrivatePromotionSwitchIntent } from './services/restore-private-promotion-switch-authentication';
import {
  ensureSignedRestorePrivatePromotionSwitchCompletionReceipt,
  type RestorePrivatePromotionPostSwitchHealthcheck,
} from './services/restore-private-promotion-switch-completion-receipt';
import { readVerifiedRestorePrivatePromotionSwitchExecutionEvents } from './services/restore-private-promotion-switch-execution';
import { readVerifiedRestorePrivatePromotionSwitchJournal } from './services/restore-private-promotion-switch-journal';

const MODE = 'ISOLATED_RESTORE_PROMOTION_SWITCH_COMPLETION_RECEIPT' as const;

function requireAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function readHealthcheck(filePath: string): Promise<Readonly<RestorePrivatePromotionPostSwitchHealthcheck>> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Post-switch healthcheck must be a regular non-symlink file');
  return JSON.parse(await readFile(filePath, 'utf8')) as RestorePrivatePromotionPostSwitchHealthcheck;
}

async function main(): Promise<void> {
  const intentFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE');
  const journalFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE');
  const executionDir = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR');
  const healthcheckFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_POST_SWITCH_HEALTHCHECK_FILE');
  const keyFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');

  const intent = await readAuthenticatedRestorePrivatePromotionSwitchIntent(intentFile, keyFile);
  const journal = await readVerifiedRestorePrivatePromotionSwitchJournal(journalFile, keyFile, intent);
  const events = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(executionDir, keyFile, journal);
  const healthcheck = await readHealthcheck(healthcheckFile);
  const result = await ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(
    executionDir,
    keyFile,
    journal,
    events,
    healthcheck,
    new Date().toISOString(),
  );

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'SIGNED_COMPLETION_RECEIPT_READY',
    receiptCreated: result.created,
    receiptReused: !result.created,
    receiptPath: result.path,
    receiptSignature: result.envelope.signature,
    candidateSetId: result.envelope.record.candidateSetId,
    postSwitchHealthcheckFingerprint: result.envelope.record.postSwitchHealthcheckFingerprint,
    promotionExecuted: result.envelope.record.promotionExecuted,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion completion receipt failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
