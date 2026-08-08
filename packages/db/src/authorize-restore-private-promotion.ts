import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createDatabase } from './client';
import type { RestorePrivacyArtifactReplayResult } from './services/restore-privacy-artifact-replay';
import type { RestorePrivacyArtifactReplayManifest } from './services/restore-privacy-artifact-replay-manifest';
import {
  ensureSignedRestorePrivatePromotionIntent,
} from './services/restore-private-promotion-intent';
import {
  assessRestorePrivatePromotionReadiness,
  type RestorePrivatePromotionRecoveryEvidenceInput,
} from './services/restore-private-promotion-readiness';
import {
  RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME,
} from './services/restore-private-recovery-intent';
import type { RestorePrivateRecoveryPlan } from './services/restore-private-recovery-plan';
import {
  RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME,
} from './services/restore-private-recovery-receipt';
import { createRestorePrivacyReconciliationReportFromStorage } from './services/restore-privacy-reconciliation-report';

const RESTORE_PRIVATE_PROMOTION_INTENT_CLI_MODE = 'ISOLATED_RESTORE_PROMOTION_INTENT' as const;
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

function optionalAbsoluteEnvironmentPath(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
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
    keyFile: optionalAbsoluteEnvironmentPath('RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE'),
  });
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
  const recoveryExecutionDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_RECOVERY_INTENT_DIR');

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
  const recoveryEvidence = await recoveryEvidenceFromStorage(recoveryPlanFile, recoveryExecutionDir);

  const readiness = await assessRestorePrivatePromotionReadiness(
    createDatabase(),
    reconciliation,
    artifactManifest,
    artifactResult,
    { reportRoot, tenantExportRoot, dataSubjectDeliveryRoot },
    recoveryEvidence,
  );

  if (!readiness.promotionAllowed || readiness.status !== 'PROMOTION_READY') {
    process.stdout.write(`${JSON.stringify({
      mode: RESTORE_PRIVATE_PROMOTION_INTENT_CLI_MODE,
      status: 'BLOCKED',
      promotionAllowed: false,
      authorizationPersisted: false,
      promotionExecuted: false,
      readiness,
    })}\n`);
    process.exitCode = 3;
    return;
  }

  const promotionIntentDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_DIR');
  const promotionKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE');
  const intent = await ensureSignedRestorePrivatePromotionIntent({
    targetDir: promotionIntentDir,
    keyFile: promotionKeyFile,
    readiness,
    authorizedAt: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify({
    mode: RESTORE_PRIVATE_PROMOTION_INTENT_CLI_MODE,
    status: 'AUTHORIZED',
    backupCutoff: readiness.backupCutoff,
    promotionAllowed: true,
    authorizationPersisted: true,
    promotionExecuted: false,
    evidenceFingerprint: readiness.evidenceFingerprint,
    intentCreated: intent.created,
    intentReused: !intent.created,
    authorizedAt: intent.envelope.record.authorizedAt,
    intentSignature: intent.envelope.signature,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore private promotion intent authorization failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
