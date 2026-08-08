import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { createRestorePrivacyReconciliationReportFromStorage } from './services/restore-privacy-reconciliation-report';
import { assessRestorePrivacyReplayDatabase } from './services/restore-privacy-replay-assessment';

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface StagedBackupManifest {
  bundleVersion?: unknown;
  createdAt?: unknown;
  restoreReconciliationRequired?: unknown;
}

function requireAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

async function readBackupCutoff(manifestPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as StagedBackupManifest;
  if (parsed.bundleVersion !== 1) throw new Error('Staged backup manifest version is not supported');
  if (parsed.restoreReconciliationRequired !== true) {
    throw new Error('Staged backup manifest does not require privacy reconciliation');
  }
  if (
    typeof parsed.createdAt !== 'string'
    || !CANONICAL_UTC_TIMESTAMP.test(parsed.createdAt)
    || !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw new Error('Staged backup manifest creation time is invalid');
  }
  return parsed.createdAt;
}

async function main(): Promise<void> {
  const manifestPath = requireAbsoluteEnvironmentPath('RESTORE_STAGING_MANIFEST');
  const ledgerDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_DIR');
  const ledgerKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_KEY_FILE');
  const journalDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_EFFECT_JOURNAL_DIR');
  const journalKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE');
  const backupCutoff = await readBackupCutoff(manifestPath);
  const reconciliation = await createRestorePrivacyReconciliationReportFromStorage({
    backupCutoff,
    ledgerDir,
    ledgerKeyFile,
    journalDir,
    journalKeyFile,
  });

  const assessment = await assessRestorePrivacyReplayDatabase(createDatabase(), reconciliation);
  process.stdout.write(`${JSON.stringify({ reconciliation, assessment })}\n`);
  if (assessment.status === 'BLOCKED') process.exitCode = 3;
  else if (assessment.status === 'DATABASE_REPLAY_REQUIRED') process.exitCode = 4;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore privacy replay assessment failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
