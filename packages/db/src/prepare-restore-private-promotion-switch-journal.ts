import { isAbsolute } from 'node:path';
import {
  readVerifiedRestorePrivatePromotionSwitchIntent,
  type RestorePrivatePromotionCandidateSetHealthcheck,
} from './services/restore-private-promotion-switch-intent';
import { ensureSignedRestorePrivatePromotionSwitchJournal } from './services/restore-private-promotion-switch-journal';

const MODE = 'ISOLATED_RESTORE_PROMOTION_SWITCH_JOURNAL' as const;

function requireAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function readHealthcheck(filePath: string): Promise<Readonly<RestorePrivatePromotionCandidateSetHealthcheck>> {
  const { readFile, lstat } = await import('node:fs/promises');
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion candidate healthcheck must be a regular non-symlink file');
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as RestorePrivatePromotionCandidateSetHealthcheck;
}

async function main(): Promise<void> {
  const healthcheckFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_CANDIDATE_HEALTHCHECK_FILE');
  const switchIntentFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE');
  const keyFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const journalDir = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_DIR');

  const healthcheck = await readHealthcheck(healthcheckFile);
  const switchIntent = await readVerifiedRestorePrivatePromotionSwitchIntent(
    switchIntentFile,
    keyFile,
    healthcheck,
  );
  const result = await ensureSignedRestorePrivatePromotionSwitchJournal({
    targetDir: journalDir,
    keyFile,
    switchIntent,
    startedAt: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'PENDING_JOURNAL_READY',
    switchIntentVerified: true,
    journalCreated: result.created,
    journalReused: !result.created,
    journalPath: result.path,
    journalFingerprint: result.envelope.record.journalFingerprint,
    journalSignature: result.envelope.signature,
    candidateSetId: result.envelope.record.candidateSetId,
    candidateSetFingerprint: result.envelope.record.candidateSetFingerprint,
    productionSwitchAuthorized: result.envelope.record.productionSwitchAuthorized,
    productionMutationAllowed: false,
    productionMutationStarted: result.envelope.record.productionMutationStarted,
    promotionExecuted: result.envelope.record.promotionExecuted,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion switch journal preparation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
