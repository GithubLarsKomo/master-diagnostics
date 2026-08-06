import { verifyEncryptedBackupBundle } from './services/backup-restore-verification';

const bundlePath = process.env.BACKUP_BUNDLE_FILE?.trim();
const checksumPath = process.env.BACKUP_CHECKSUM_FILE?.trim();
const keyFile = process.env.BACKUP_KEY_FILE?.trim() || '/run/secrets/backup.key';

if (!bundlePath) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'BACKUP_BUNDLE_FILE is required' })}\n`);
  process.exitCode = 1;
} else {
  try {
    const verified = await verifyEncryptedBackupBundle({
      bundlePath,
      checksumPath: checksumPath || `${bundlePath}.sha256`,
      keyFile,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      fileName: verified.fileName,
      sha256: verified.sha256,
      bundleVersion: verified.manifest.bundleVersion,
      createdAt: verified.manifest.createdAt,
      consistency: verified.manifest.consistency,
      restoreReconciliationRequired: verified.manifest.restoreReconciliationRequired,
    })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backup verification error';
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}
