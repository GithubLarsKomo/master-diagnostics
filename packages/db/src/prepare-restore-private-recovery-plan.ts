import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import type { RestorePrivacyArtifactReplayResult } from './services/restore-privacy-artifact-replay';
import type { RestorePrivacyArtifactReplayManifest } from './services/restore-privacy-artifact-replay-manifest';
import { prepareRestorePrivateRecoveryPlan } from './services/restore-private-recovery-planning';
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

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function readJsonIfPresent<T>(filePath: string, label: string): Promise<T | null> {
  let serialized: string;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
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
  const recoveryPlanFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_RECOVERY_PLAN_FILE');
  const backupCutoff = await readBackupCutoff(stagingManifestPath);

  const reconciliation = await createRestorePrivacyReconciliationReportFromStorage({
    backupCutoff,
    ledgerDir,
    ledgerKeyFile,
    journalDir,
    journalKeyFile,
  });
  const artifactManifest = await readJsonIfPresent<RestorePrivacyArtifactReplayManifest>(
    artifactManifestFile,
    'Restore privacy artifact replay manifest',
  );
  const artifactResult = await readJsonIfPresent<RestorePrivacyArtifactReplayResult>(
    artifactResultFile,
    'Restore privacy artifact replay result',
  );

  const result = await prepareRestorePrivateRecoveryPlan(
    createDatabase(),
    reconciliation,
    artifactManifest,
    artifactResult,
    { reportRoot, tenantExportRoot, dataSubjectDeliveryRoot },
    recoveryPlanFile,
  );

  process.stdout.write(`${JSON.stringify({
    mode: 'ISOLATED_RESTORE_RECOVERY_PLAN',
    ...result,
  })}\n`);
  if (result.status === 'BLOCKED') process.exitCode = 3;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore private recovery planning failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
