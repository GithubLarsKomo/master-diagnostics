import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import {
  buildRestorePrivacyArtifactReplayManifest,
  persistRestorePrivacyArtifactReplayManifest,
  readVerifiedRestorePrivacyArtifactReplayManifestIfPresent,
} from './services/restore-privacy-artifact-replay-manifest';
import { createRestorePrivacyReconciliationReportFromStorage } from './services/restore-privacy-reconciliation-report';

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
  const outputFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_ARTIFACT_MANIFEST_FILE');
  const backupCutoff = await readBackupCutoff(manifestPath);
  const report = await createRestorePrivacyReconciliationReportFromStorage({
    backupCutoff,
    ledgerDir,
    ledgerKeyFile,
    journalDir,
    journalKeyFile,
  });
  if (report.status === 'BLOCKED') {
    throw new Error(`Restore privacy reconciliation is blocked: ${report.blockers.map((item) => item.code).join(', ')}`);
  }

  const existing = await readVerifiedRestorePrivacyArtifactReplayManifestIfPresent(outputFile, report);
  const artifactManifest = existing ?? await buildRestorePrivacyArtifactReplayManifest(createDatabase(), report);
  const persisted = existing
    ? { created: false, manifest: artifactManifest }
    : await persistRestorePrivacyArtifactReplayManifest(outputFile, artifactManifest);

  process.stdout.write(`${JSON.stringify({
    mode: 'RESTORE_PRIVACY_ARTIFACT_REPLAY_PLAN',
    backupCutoff,
    reconciliationStatus: artifactManifest.reconciliationStatus,
    obligationCount: artifactManifest.obligationCount,
    entryCount: artifactManifest.entryCount,
    obligationsFingerprint: artifactManifest.obligationsFingerprint,
    entriesFingerprint: artifactManifest.entriesFingerprint,
    created: persisted.created,
    reused: existing !== null,
    promotionAllowed: false,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore privacy artifact replay manifest creation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
