import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { buildRestorePrivacyReconciliationLedger } from './services/backup-restore-privacy-ledger';

async function main(): Promise<void> {
  const backupCreatedAt = process.env.RESTORE_BACKUP_CREATED_AT?.trim();
  const outputPath = process.env.RESTORE_PRIVACY_LEDGER_OUTPUT?.trim();
  if (!backupCreatedAt) throw new Error('RESTORE_BACKUP_CREATED_AT is required');
  if (!outputPath) throw new Error('RESTORE_PRIVACY_LEDGER_OUTPUT is required');
  if (!isAbsolute(outputPath)) throw new Error('RESTORE_PRIVACY_LEDGER_OUTPUT must be an absolute path');

  const ledger = await buildRestorePrivacyReconciliationLedger(
    createDatabase(),
    backupCreatedAt,
  );
  await writeFile(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ledgerVersion: ledger.ledgerVersion,
    backupCreatedAt: ledger.backupCreatedAt,
    generatedAt: ledger.generatedAt,
    entryCount: ledger.entryCount,
    fingerprint: ledger.fingerprint,
    outputPath,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore privacy ledger creation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
