import { isAbsolute, join } from 'node:path';
import { readAuthenticatedRestorePrivatePromotionSwitchIntent } from './services/restore-private-promotion-switch-authentication';
import {
  RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME,
  readVerifiedRestorePrivatePromotionSwitchCompletionReceipt,
} from './services/restore-private-promotion-switch-completion-receipt';
import {
  assessRestorePrivatePromotionSwitchExecution,
  readVerifiedRestorePrivatePromotionSwitchExecutionEvents,
  type RestorePrivatePromotionCurrentVolumeSet,
} from './services/restore-private-promotion-switch-execution';
import { readVerifiedRestorePrivatePromotionSwitchJournal } from './services/restore-private-promotion-switch-journal';

const MODE = 'ISOLATED_RESTORE_PROMOTION_SWITCH_EXECUTION_ASSESSMENT' as const;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function requireAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requireVolumeName(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${name} is not a safe Docker volume name`);
  return value;
}

function currentVolumesFromEnvironment(): Readonly<RestorePrivatePromotionCurrentVolumeSet> {
  return Object.freeze({
    libsql: requireVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_LIBSQL_VOLUME'),
    reports: requireVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_REPORTS_VOLUME'),
    tenantExports: requireVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_TENANT_EXPORTS_VOLUME'),
    dataSubjectDelivery: requireVolumeName('RESTORE_PRIVATE_PROMOTION_ACTIVE_DATA_SUBJECT_DELIVERY_VOLUME'),
  });
}

async function main(): Promise<void> {
  const switchIntentFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE');
  const journalFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE');
  const executionDir = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR');
  const keyFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const currentVolumes = currentVolumesFromEnvironment();

  const intent = await readAuthenticatedRestorePrivatePromotionSwitchIntent(switchIntentFile, keyFile);
  const journal = await readVerifiedRestorePrivatePromotionSwitchJournal(journalFile, keyFile, intent);
  const events = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(executionDir, keyFile, journal);
  const assessment = assessRestorePrivatePromotionSwitchExecution(journal, events, currentVolumes);

  let completionReceiptVerified = false;
  if (assessment.status === 'COMPLETED') {
    await readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(
      join(executionDir, RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME),
      keyFile,
      journal,
      events,
    );
    completionReceiptVerified = true;
  }

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    ...assessment,
    switchIntentAuthenticated: true,
    journalVerified: true,
    eventCount: events.length,
    completionReceiptVerified,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion switch execution assessment failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
