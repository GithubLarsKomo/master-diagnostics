import { join } from 'node:path';
import { readAuthenticatedRestorePrivatePromotionSwitchIntent } from './services/restore-private-promotion-switch-authentication';
import {
  RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_FILE_NAME,
  readVerifiedRestorePrivatePromotionSourceProvenanceBinding,
} from './services/restore-private-promotion-source-provenance-binding';
import {
  readVerifiedRestorePrivatePromotionSwitchCompletionReceipt,
  RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME,
} from './services/restore-private-promotion-switch-completion-receipt';
import { readVerifiedRestorePrivatePromotionSwitchExecutionEvents } from './services/restore-private-promotion-switch-execution';
import { readVerifiedRestorePrivatePromotionSwitchJournal } from './services/restore-private-promotion-switch-journal';

const MODE = 'RESTORE_PROMOTION_SWITCH_COMPLETION_RECEIPT_VERIFICATION' as const;

function requireAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!value.startsWith('/')) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function main(): Promise<void> {
  const intentFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE');
  const journalFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE');
  const executionDir = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR');
  const keyFile = requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const receiptFile = join(executionDir, RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME);

  const intent = await readAuthenticatedRestorePrivatePromotionSwitchIntent(intentFile, keyFile);
  const sourceBinding = await readVerifiedRestorePrivatePromotionSourceProvenanceBinding(
    join(executionDir, RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_FILE_NAME),
    keyFile,
    intent,
  );
  const journal = await readVerifiedRestorePrivatePromotionSwitchJournal(journalFile, keyFile, intent);
  const events = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(executionDir, keyFile, journal);
  const receipt = await readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(
    receiptFile,
    keyFile,
    journal,
    events,
    sourceBinding,
  );

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'VERIFIED',
    receiptVersion: receipt.record.receiptVersion,
    receiptSignature: receipt.signature,
    completedAt: receipt.record.completedAt,
    journalFingerprint: receipt.record.journalFingerprint,
    journalSignature: receipt.record.journalSignature,
    candidateSetId: receipt.record.candidateSetId,
    candidateSetFingerprint: receipt.record.candidateSetFingerprint,
    candidateSelectedEventSignature: receipt.record.candidateSelectedEventSignature,
    sourceProvenanceBindingSignature: receipt.record.sourceProvenanceBindingSignature,
    sourceProvenanceBindingFingerprint: receipt.record.sourceProvenanceBindingFingerprint,
    sourceProvenanceSignature: receipt.record.sourceProvenanceSignature,
    sourceStagingName: receipt.record.sourceStagingName,
    sourceBackupFileName: receipt.record.sourceBackupFileName,
    sourceBackupSha256: receipt.record.sourceBackupSha256,
    sourceBackupCreatedAt: receipt.record.sourceBackupCreatedAt,
    sourceBackupManifestFingerprint: receipt.record.sourceBackupManifestFingerprint,
    postSwitchHealthcheckFingerprint: receipt.record.postSwitchHealthcheckFingerprint,
    currentVolumeSet: receipt.record.currentVolumeSet,
    libsqlHealth: receipt.record.libsqlHealth,
    appHealth: receipt.record.appHealth,
    exportCleanupRunning: receipt.record.exportCleanupRunning,
    retentionScanRunning: receipt.record.retentionScanRunning,
    caddyPreserved: receipt.record.caddyPreserved,
    rollbackVolumesRetained: receipt.record.rollbackVolumesRetained,
    productionMutationCompleted: receipt.record.productionMutationCompleted,
    promotionExecuted: receipt.record.promotionExecuted,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion completion receipt verification failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
