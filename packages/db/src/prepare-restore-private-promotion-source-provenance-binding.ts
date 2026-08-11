import { isAbsolute } from 'node:path';
import { ensureSignedRestorePrivatePromotionSourceProvenanceBinding } from './services/restore-private-promotion-source-provenance-binding';

const MODE = 'ISOLATED_RESTORE_PROMOTION_SOURCE_PROVENANCE_BINDING' as const;

function requireAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function main(): Promise<void> {
  const result = await ensureSignedRestorePrivatePromotionSourceProvenanceBinding({
    targetDir: requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_DIR'),
    promotionKeyFile: requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE'),
    backupKeyFile: requireAbsolutePath('BACKUP_KEY_FILE'),
    sourceProvenanceFile: requireAbsolutePath('RESTORE_SOURCE_PROVENANCE_FILE'),
    switchIntentFile: requireAbsolutePath('RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE'),
  });

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'SOURCE_PROVENANCE_BOUND',
    bindingCreated: result.created,
    bindingReused: !result.created,
    bindingPath: result.path,
    bindingSignature: result.envelope.signature,
    bindingFingerprint: result.envelope.record.bindingFingerprint,
    stagingName: result.envelope.record.stagingName,
    backupFileName: result.envelope.record.backupFileName,
    backupSha256: result.envelope.record.backupSha256,
    backupCreatedAt: result.envelope.record.backupCreatedAt,
    backupManifestFingerprint: result.envelope.record.backupManifestFingerprint,
    candidateSetId: result.envelope.record.candidateSetId,
    planFingerprint: result.envelope.record.planFingerprint,
    productionMutationAllowed: false,
    promotionExecuted: false,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion source-provenance binding failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
