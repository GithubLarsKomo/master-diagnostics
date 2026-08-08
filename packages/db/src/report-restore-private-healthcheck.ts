import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { readVerifiedRestorePrivacyArtifactReplayResultIfPresent } from './services/restore-privacy-artifact-replay';
import { readVerifiedRestorePrivacyArtifactReplayManifestIfPresent } from './services/restore-privacy-artifact-replay-manifest';
import { assessRestorePrivateHealthcheck } from './services/restore-private-healthcheck';
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
  const stagingManifestPath = requireAbsoluteEnvironmentPath('RESTORE_STAGING_MANIFEST');
  const ledgerDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_DIR');
  const ledgerKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_KEY_FILE');
  const journalDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_EFFECT_JOURNAL_DIR');
  const journalKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE');
  const artifactManifestFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_ARTIFACT_MANIFEST_FILE');
  const artifactResultFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_ARTIFACT_RESULT_FILE');
  const reportRoot = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_REPORT_ROOT');
  const tenantExportRoot = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_TENANT_EXPORT_ROOT');
  const dataSubjectDeliveryRoot = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_DATA_SUBJECT_DELIVERY_ROOT');
  const backupCutoff = await readBackupCutoff(stagingManifestPath);

  const reconciliation = await createRestorePrivacyReconciliationReportFromStorage({
    backupCutoff,
    ledgerDir,
    ledgerKeyFile,
    journalDir,
    journalKeyFile,
  });
  const artifactManifest = await readVerifiedRestorePrivacyArtifactReplayManifestIfPresent(
    artifactManifestFile,
    reconciliation,
  );
  const artifactResult = artifactManifest
    ? await readVerifiedRestorePrivacyArtifactReplayResultIfPresent(artifactResultFile, artifactManifest)
    : null;

  const report = await assessRestorePrivateHealthcheck(
    createDatabase(),
    reconciliation,
    artifactManifest,
    artifactResult,
    { reportRoot, tenantExportRoot, dataSubjectDeliveryRoot },
  );

  process.stdout.write(`${JSON.stringify({
    mode: 'ISOLATED_RESTORE_HEALTHCHECK',
    ...report,
  })}\n`);
  if (!report.healthcheckPassed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore private healthcheck failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
