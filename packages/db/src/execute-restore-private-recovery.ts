import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { executeRestorePrivateRecovery } from './services/restore-private-recovery-executor';
import {
  ensureSignedRestorePrivateRecoveryIntent,
} from './services/restore-private-recovery-intent';
import type { RestorePrivateRecoveryPlan } from './services/restore-private-recovery-plan';
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

async function readRecoveryPlan(filePath: string): Promise<Readonly<RestorePrivateRecoveryPlan>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error('Restore private recovery plan cannot be read as JSON', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Restore private recovery plan is invalid');
  }
  return parsed as Readonly<RestorePrivateRecoveryPlan>;
}

async function main(): Promise<void> {
  const stagingManifestPath = requireAbsoluteEnvironmentPath('RESTORE_STAGING_MANIFEST');
  const ledgerDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_DIR');
  const ledgerKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_LEDGER_KEY_FILE');
  const journalDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_EFFECT_JOURNAL_DIR');
  const journalKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE');
  const recoveryPlanFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_RECOVERY_PLAN_FILE');
  const intentDir = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_RECOVERY_INTENT_DIR');
  const intentKeyFile = requireAbsoluteEnvironmentPath('RESTORE_PRIVATE_RECOVERY_INTENT_KEY_FILE');
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
  const plan = await readRecoveryPlan(recoveryPlanFile);
  const intent = await ensureSignedRestorePrivateRecoveryIntent({
    targetDir: intentDir,
    keyFile: intentKeyFile,
    plan,
    reconciliation,
    startedAt: new Date().toISOString(),
  });
  const result = await executeRestorePrivateRecovery(createDatabase(), {
    plan,
    reconciliation,
    intentFile: intent.path,
    intentKeyFile,
    roots: { reportRoot, tenantExportRoot, dataSubjectDeliveryRoot },
  });

  process.stdout.write(`${JSON.stringify({
    ...result,
    intentCreated: intent.created,
    intentReused: !intent.created,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore private recovery execution failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
