import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { getRestorePrivacyReconciliationLedger } from './services/restore-privacy-ledger';
import { persistSignedRestorePrivacyLedger } from './services/restore-privacy-ledger-storage';

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
  const targetDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_DIR');
  const keyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_KEY_FILE');
  const sinceExclusive = await readBackupCutoff(manifestPath);
  const ledger = await getRestorePrivacyReconciliationLedger(createDatabase(), sinceExclusive);
  const persisted = await persistSignedRestorePrivacyLedger({ ledger, targetDir, keyFile });

  process.stdout.write(`${JSON.stringify({
    envelopeVersion: persisted.envelope.envelopeVersion,
    ledgerVersion: ledger.ledgerVersion,
    sinceExclusive: ledger.sinceExclusive,
    generatedAt: ledger.generatedAt,
    entryCount: ledger.entries.length,
    entriesFingerprint: ledger.entriesFingerprint,
    created: persisted.created,
    fileName: persisted.path.split('/').at(-1),
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore privacy ledger snapshot creation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
