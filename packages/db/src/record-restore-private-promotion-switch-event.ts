import { isAbsolute } from 'node:path';
import { readAuthenticatedRestorePrivatePromotionSwitchIntent } from './services/restore-private-promotion-switch-authentication';
import {
  ensureSignedRestorePrivatePromotionSwitchExecutionEvent,
  type RestorePrivatePromotionSwitchExecutionPhase,
} from './services/restore-private-promotion-switch-execution';
import { readVerifiedRestorePrivatePromotionSwitchJournal } from './services/restore-private-promotion-switch-journal';

const MODE = 'ISOLATED_RESTORE_PROMOTION_SWITCH_EXECUTION_EVENT' as const;
const ALLOWED_PHASES: readonly RestorePrivatePromotionSwitchExecutionPhase[] = Object.freeze([
  'CUTOVER_STARTED',
  'CANDIDATE_SELECTED',
  'COMPLETED',
  'ROLLBACK_STARTED',
  'ROLLBACK_SELECTED',
  'ROLLBACK_VERIFIED',
]);

function requireAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requirePhase(): RestorePrivatePromotionSwitchExecutionPhase {
  const value = process.env.RESTORE_PRIVATE_PROMOTION_SWITCH_EVENT_PHASE?.trim();
  if (!value || !ALLOWED_PHASES.includes(value as RestorePrivatePromotionSwitchExecutionPhase)) {
    throw new Error('RESTORE_PRIVATE_PROMOTION_SWITCH_EVENT_PHASE is invalid');
  }
  return value as RestorePrivatePromotionSwitchExecutionPhase;
}

async function main(): Promise<void> {
  const switchIntentFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE');
  const journalFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE');
  const executionDir = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR');
  const keyFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const phase = requirePhase();

  const intent = await readAuthenticatedRestorePrivatePromotionSwitchIntent(switchIntentFile, keyFile);
  const journal = await readVerifiedRestorePrivatePromotionSwitchJournal(journalFile, keyFile, intent);
  const result = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(
    executionDir,
    keyFile,
    journal,
    phase,
    new Date().toISOString(),
  );

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'EVENT_PERSISTED',
    phase,
    eventCreated: result.created,
    eventReused: !result.created,
    eventPath: result.path,
    eventSignature: result.envelope.signature,
    previousEventSignature: result.envelope.record.previousEventSignature,
    targetVolumeSet: result.envelope.record.targetVolumeSet,
    terminal: result.envelope.record.terminal,
    productionMutationApplied: false,
    promotionExecuted: result.envelope.record.promotionExecuted,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion switch execution event failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
