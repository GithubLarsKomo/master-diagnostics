import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDatabase } from './client';
import { replayRestorePrivacyObligationToDatabase } from './services/restore-privacy-db-replay';
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

  const db = createDatabase();
  const assessmentBefore = await assessRestorePrivacyReplayDatabase(db, report);
  if (assessmentBefore.status === 'BLOCKED') {
    const reasons = assessmentBefore.obligations.flatMap((item) => item.reasons).join(', ');
    throw new Error(`Restore privacy database assessment is blocked${reasons ? `: ${reasons}` : ''}`);
  }

  const assessmentByExecution = new Map(
    assessmentBefore.obligations.map((item) => [item.executionId, item] as const),
  );
  const replayedAt = new Date().toISOString();
  const results: Array<Awaited<ReturnType<typeof replayRestorePrivacyObligationToDatabase>>> = [];
  for (const obligation of report.obligations) {
    const assessment = assessmentByExecution.get(obligation.executionId);
    if (!assessment) throw new Error(`Restore privacy database assessment is missing execution ${obligation.executionId}`);
    if (assessment.status === 'DATABASE_SATISFIED') continue;
    if (assessment.status !== 'DATABASE_REPLAY_REQUIRED') {
      throw new Error(`Restore privacy database obligation is not replayable: ${obligation.executionId}`);
    }
    results.push(await replayRestorePrivacyObligationToDatabase(db, obligation, replayedAt));
  }

  const assessmentAfter = await assessRestorePrivacyReplayDatabase(db, report);
  if (assessmentAfter.status !== 'DATABASE_SATISFIED') {
    const unresolved = assessmentAfter.obligations
      .filter((item) => item.status !== 'DATABASE_SATISFIED')
      .map((item) => `${item.executionId}:${item.reasons.join('+')}`)
      .join(', ');
    throw new Error(`Restore privacy database replay did not reach the required target state${unresolved ? `: ${unresolved}` : ''}`);
  }

  process.stdout.write(`${JSON.stringify({
    mode: 'ISOLATED_RESTORE_DB_REPLAY',
    backupCutoff,
    reconciliationStatus: report.status,
    databaseAssessmentBefore: assessmentBefore.status,
    databaseAssessmentAfter: assessmentAfter.status,
    promotionAllowed: false,
    obligationCount: report.obligations.length,
    databaseSatisfiedBeforeCount: assessmentBefore.obligations.filter((item) => item.status === 'DATABASE_SATISFIED').length,
    replayRequiredCount: assessmentBefore.obligations.filter((item) => item.status === 'DATABASE_REPLAY_REQUIRED').length,
    appliedCount: results.filter((item) => item.result === 'APPLIED').length,
    alreadyAppliedCount: results.filter((item) => item.result === 'ALREADY_APPLIED').length,
    executions: results.map((item) => ({
      executionId: item.executionId,
      result: item.result,
      dbCommittedAt: item.dbCommittedAt,
      replayedAt: item.replayedAt,
    })),
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore privacy database replay failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
