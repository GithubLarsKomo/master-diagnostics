import { stageEncryptedBackupRestore } from './services/backup-restore-staging';

const bundlePath = process.env.BACKUP_BUNDLE_FILE?.trim();
const checksumPath = process.env.BACKUP_CHECKSUM_FILE?.trim();
const keyFile = process.env.BACKUP_KEY_FILE?.trim() || '/run/secrets/backup.key';
const stagingRoot = process.env.RESTORE_STAGING_ROOT?.trim() || '/restore-staging';

if (!bundlePath) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'BACKUP_BUNDLE_FILE is required' })}\n`);
  process.exitCode = 1;
} else {
  try {
    const staged = await stageEncryptedBackupRestore({
      bundlePath,
      checksumPath: checksumPath || `${bundlePath}.sha256`,
      keyFile,
      stagingRoot,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      stagingName: staged.stagingName,
      fileName: staged.fileName,
      sha256: staged.sha256,
      createdAt: staged.createdAt,
      restoreReconciliationRequired: staged.restoreReconciliationRequired,
      sources: staged.sourceNames,
    })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backup restore staging error';
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}
