import { createEncryptedBackupBundle } from './services/backup-bundle';

const sourceDir = process.env.BACKUP_SOURCE_DIR ?? '/backup-source';
const targetDir = process.env.BACKUP_TARGET_DIR ?? '/backup-target';
const keyFile = process.env.BACKUP_KEY_FILE ?? '/run/secrets/backup.key';

try {
  const result = await createEncryptedBackupBundle({ sourceDir, targetDir, keyFile });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    bundleVersion: result.manifest.bundleVersion,
    fileName: result.fileName,
    sha256: result.sha256,
    createdAt: result.createdAt,
    restoreReconciliationRequired: result.manifest.restoreReconciliationRequired,
  })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown backup bundle error';
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}
