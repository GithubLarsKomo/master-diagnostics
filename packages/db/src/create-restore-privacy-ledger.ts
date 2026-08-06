import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { buildRestorePrivacyReconciliationLedger } from './services/backup-restore-privacy-ledger';

interface StagedBackupManifest {
  bundleVersion?: unknown;
  createdAt?: unknown;
  restoreReconciliationRequired?: unknown;
}

async function readStagedBackupCreatedAt(manifestPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as StagedBackupManifest;
  if (parsed.bundleVersion !== 1) throw new Error('Staged backup manifest version is not supported');
  if (parsed.restoreReconciliationRequired !== true) {
    throw new Error('Staged backup manifest does not require privacy reconciliation');
  }
  if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) {
    throw new Error('Staged backup manifest creation time is invalid');
  }
  return parsed.createdAt;
}

async function main(): Promise<void> {
  const manifestPath = process.env.RESTORE_STAGING_MANIFEST?.trim();
  const outputPath = process.env.RESTORE_PRIVACY_LEDGER_OUTPUT?.trim();
  if (!manifestPath) throw new Error('RESTORE_STAGING_MANIFEST is required');
  if (!outputPath) throw new Error('RESTORE_PRIVACY_LEDGER_OUTPUT is required');
  if (!isAbsolute(manifestPath)) throw new Error('RESTORE_STAGING_MANIFEST must be an absolute path');
  if (!isAbsolute(outputPath)) throw new Error('RESTORE_PRIVACY_LEDGER_OUTPUT must be an absolute path');

  const backupCreatedAt = await readStagedBackupCreatedAt(manifestPath);
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
