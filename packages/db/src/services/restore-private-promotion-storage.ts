import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Database } from '../client';
import type { RestorePrivacyArtifactReplayResult } from './restore-privacy-artifact-replay';
import type { RestorePrivacyArtifactReplayManifest } from './restore-privacy-artifact-replay-manifest';
import {
  assessRestorePrivatePromotionReadiness,
  type RestorePrivatePromotionReadinessReport,
  type RestorePrivatePromotionRecoveryEvidenceInput,
} from './restore-private-promotion-readiness';
import { RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME } from './restore-private-recovery-intent';
import type { RestorePrivateRecoveryPlan } from './restore-private-recovery-plan';
import { RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME } from './restore-private-recovery-receipt';
import { createRestorePrivacyReconciliationReportFromStorage } from './restore-privacy-reconciliation-report';

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface StagedBackupManifest {
  bundleVersion?: unknown;
  createdAt?: unknown;
  restoreReconciliationRequired?: unknown;
}

export interface RestorePrivatePromotionStoragePaths {
  readonly stagingManifestPath: string;
  readonly ledgerDir: string;
  readonly ledgerKeyFile: string;
  readonly journalDir: string;
  readonly journalKeyFile: string;
  readonly artifactManifestFile: string;
  readonly artifactResultFile: string;
  readonly reportRoot: string;
  readonly tenantExportRoot: string;
  readonly dataSubjectDeliveryRoot: string;
  readonly recoveryPlanFile: string;
  readonly recoveryExecutionDir: string;
  readonly recoveryKeyFile: string | null;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.trim() || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function assertPaths(paths: Readonly<RestorePrivatePromotionStoragePaths>): void {
  const required: readonly (readonly [string, string])[] = [
    [paths.stagingManifestPath, 'Restore staging manifest path'],
    [paths.ledgerDir, 'Restore privacy ledger directory'],
    [paths.ledgerKeyFile, 'Restore privacy ledger key path'],
    [paths.journalDir, 'Restore privacy effect journal directory'],
    [paths.journalKeyFile, 'Restore privacy effect journal key path'],
    [paths.artifactManifestFile, 'Restore privacy artifact manifest path'],
    [paths.artifactResultFile, 'Restore privacy artifact result path'],
    [paths.reportRoot, 'Restore report root'],
    [paths.tenantExportRoot, 'Restore tenant export root'],
    [paths.dataSubjectDeliveryRoot, 'Restore data subject delivery root'],
    [paths.recoveryPlanFile, 'Restore private recovery plan path'],
    [paths.recoveryExecutionDir, 'Restore private recovery execution directory'],
  ];
  for (const [value, label] of required) assertAbsolutePath(value, label);
  if (paths.recoveryKeyFile !== null) {
    assertAbsolutePath(paths.recoveryKeyFile, 'Restore private recovery key path');
  }
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

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Restore promotion evidence path is not a regular non-symlink file: ${filePath}`);
    }
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
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

async function recoveryEvidenceFromStorage(
  planFile: string,
  recoveryExecutionDir: string,
  recoveryKeyFile: string | null,
): Promise<Readonly<RestorePrivatePromotionRecoveryEvidenceInput>> {
  const plan = await readJsonIfPresent<RestorePrivateRecoveryPlan>(
    planFile,
    'Restore private recovery plan',
  );
  const intentFile = join(recoveryExecutionDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME);
  const receiptFile = join(recoveryExecutionDir, RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME);
  const [intentExists, receiptExists] = await Promise.all([
    regularFileExists(intentFile),
    regularFileExists(receiptFile),
  ]);
  const evidencePresent = plan !== null || intentExists || receiptExists;
  if (!evidencePresent) {
    return Object.freeze({ plan: null, intentFile: null, receiptFile: null, keyFile: null });
  }
  return Object.freeze({
    plan,
    intentFile: intentExists ? intentFile : null,
    receiptFile: receiptExists ? receiptFile : null,
    keyFile: recoveryKeyFile,
  });
}

/** Reconstructs promotion readiness exclusively from current raw restore evidence. */
export async function assessRestorePrivatePromotionReadinessFromStorage(
  db: Database,
  paths: Readonly<RestorePrivatePromotionStoragePaths>,
): Promise<Readonly<RestorePrivatePromotionReadinessReport>> {
  assertPaths(paths);
  const backupCutoff = await readBackupCutoff(paths.stagingManifestPath);
  const reconciliation = await createRestorePrivacyReconciliationReportFromStorage({
    backupCutoff,
    ledgerDir: paths.ledgerDir,
    ledgerKeyFile: paths.ledgerKeyFile,
    journalDir: paths.journalDir,
    journalKeyFile: paths.journalKeyFile,
  });
  const artifactManifest = await readJsonIfPresent<RestorePrivacyArtifactReplayManifest>(
    paths.artifactManifestFile,
    'Restore privacy artifact replay manifest',
  );
  const artifactResult = await readJsonIfPresent<RestorePrivacyArtifactReplayResult>(
    paths.artifactResultFile,
    'Restore privacy artifact replay result',
  );
  const recoveryEvidence = await recoveryEvidenceFromStorage(
    paths.recoveryPlanFile,
    paths.recoveryExecutionDir,
    paths.recoveryKeyFile,
  );
  return assessRestorePrivatePromotionReadiness(
    db,
    reconciliation,
    artifactManifest,
    artifactResult,
    {
      reportRoot: paths.reportRoot,
      tenantExportRoot: paths.tenantExportRoot,
      dataSubjectDeliveryRoot: paths.dataSubjectDeliveryRoot,
    },
    recoveryEvidence,
  );
}
