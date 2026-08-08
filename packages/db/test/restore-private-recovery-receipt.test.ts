import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import type { RestorePrivateRecoveryAssessment } from '../src/services/restore-private-recovery-assessment';
import type { RestorePrivateRecoveryExecutionResult } from '../src/services/restore-private-recovery-executor';
import {
  ensureSignedRestorePrivateRecoveryIntent,
  RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME,
} from '../src/services/restore-private-recovery-intent';
import { buildRestorePrivateRecoveryPlan } from '../src/services/restore-private-recovery-plan';
import {
  ensureSignedRestorePrivateRecoveryReceipt,
  readVerifiedRestorePrivateRecoveryReceipt,
  RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME,
} from '../src/services/restore-private-recovery-receipt';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;
const recoveryStartedAt = '2026-08-08T10:00:00.000Z';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-receipt-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function roots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-receipt-'));
  const reportRoot = join(workspace, 'reports');
  const tenantExportRoot = join(workspace, 'tenant-exports');
  const dataSubjectDeliveryRoot = join(workspace, 'data-subject-delivery');
  await Promise.all([
    mkdir(reportRoot, { recursive: true }),
    mkdir(tenantExportRoot, { recursive: true }),
    mkdir(dataSubjectDeliveryRoot, { recursive: true }),
  ]);
  return { workspace, reportRoot, tenantExportRoot, dataSubjectDeliveryRoot };
}

async function put(path: string, value = 'artifact'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function signingKey(workspace: string): Promise<string> {
  const keyFile = join(workspace, 'recovery-intent.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 23).toString('base64')}\n`, { mode: 0o600 });
  return keyFile;
}

async function seedArtifactsStagedExecution(db: Database): Promise<void> {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 5, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Ada', lastName: 'Athlete',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 170,
    currentWeightKgX100: 6500, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: createdAt, deletedAt: createdAt,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: '[REDACTED]', requestedAt: createdAt, decidedAt: createdAt,
    decisionReason: '[REDACTED]', completedAt: createdAt, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteAnonymizationApprovals).values({
    id: 'approval-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deletionRequestId: 'deletion-a',
    approvalVersion: 1, policyVersion: '1.6.0', assessedAt: createdAt,
    scopeFingerprint, capabilityFingerprint, approvedByUserId: 'admin-a', approvedAt: createdAt,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteAnonymizationExecutions).values({
    id: executionId, tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: 'approval-a',
    executionVersion: 1, status: 'PREPARING', preparedByUserId: 'admin-a', preparedAt: createdAt,
    artifactsStagedAt: null, dbCommittedAt: null, completedAt: null, abortedAt: null,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteAnonymizationExecutionArtifacts).values({
    id: 'artifact-a', tenantId: 'tenant-a', executionId, kind: 'REPORT',
    storageReference: reportReference, createdAt, updatedAt: createdAt,
  });
  await db.update(schema.athleteAnonymizationExecutions).set({
    status: 'ARTIFACTS_STAGED',
    artifactsStagedAt: '2026-07-31T23:55:00.000Z',
    updatedAt: '2026-07-31T23:55:00.000Z',
  }).where(eq(schema.athleteAnonymizationExecutions.id, executionId));
}

function reconciliation(): Readonly<RestorePrivacyReconciliationReport> {
  return Object.freeze({
    reportVersion: 1,
    backupCutoff: cutoff,
    status: 'CLEAR',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: Object.freeze({
      generatedAt: '2026-08-08T00:00:00.000Z',
      entriesFingerprint: `sha256:${'c'.repeat(64)}`,
      entryCount: 0,
    }),
    journalMarkerCount: 0,
    obligations: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

function assessment(): Readonly<RestorePrivateRecoveryAssessment> {
  return Object.freeze({
    assessmentVersion: 1,
    backupCutoff: cutoff,
    status: 'RECOVERY_READY',
    recoveryRequired: true,
    recoveryReady: true,
    promotionAllowed: false,
    actions: Object.freeze([Object.freeze({
      executionId,
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      snapshotStatus: 'ARTIFACTS_STAGED',
      action: 'RESTORE_ARTIFACTS_AND_ABORT',
      effectBasis: 'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
      committedAt: null,
      artifactCount: 1,
      activeArtifactCount: 0,
      quarantinedArtifactCount: 1,
      absentArtifactCount: 0,
    })]),
    blockers: Object.freeze([]),
  });
}

async function fixture() {
  const db = await createTestDatabase();
  const storage = await roots();
  await seedArtifactsStagedExecution(db);
  await put(join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference), 'quarantine');
  const rec = reconciliation();
  const plan = await buildRestorePrivateRecoveryPlan(db, rec, assessment(), storage);
  const keyFile = await signingKey(storage.workspace);
  const targetDir = join(storage.workspace, 'recovery-execution');
  const intent = await ensureSignedRestorePrivateRecoveryIntent({
    targetDir,
    keyFile,
    plan,
    reconciliation: rec,
    startedAt: recoveryStartedAt,
  });
  return { storage, rec, plan, keyFile, targetDir, intent };
}

function executionResult(
  planFingerprint: `sha256:${string}`,
  status: 'APPLIED' | 'ALREADY_APPLIED' = 'APPLIED',
): Readonly<RestorePrivateRecoveryExecutionResult> {
  const applied = status === 'APPLIED';
  return Object.freeze({
    mode: 'ISOLATED_RESTORE_RECOVERY_EXECUTION',
    backupCutoff: cutoff,
    planFingerprint,
    recoveryStartedAt,
    actionCount: 1,
    appliedCount: applied ? 1 : 0,
    alreadyAppliedCount: applied ? 0 : 1,
    actions: Object.freeze([Object.freeze({
      executionId,
      action: 'RESTORE_ARTIFACTS_AND_ABORT',
      status,
      artifactMutationCount: applied ? 1 : 0,
      terminalEvidence: 'ABORTED_EXECUTION',
    })]),
    promotionAllowed: false,
  });
}

describe('restore private recovery completion receipt', () => {
  it('persists a signed terminal receipt with stable plan and intent binding', async () => {
    const { rec, plan, keyFile, targetDir, intent } = await fixture();
    const created = await ensureSignedRestorePrivateRecoveryReceipt({
      targetDir,
      keyFile,
      intentFile: intent.path,
      plan,
      reconciliation: rec,
      executionResult: executionResult(plan.planFingerprint),
      completedAt: '2026-08-08T10:30:00.000Z',
    });

    expect(created.created).toBe(true);
    expect(created.envelope.record).toMatchObject({
      receiptVersion: 1,
      phase: 'COMPLETED',
      backupCutoff: cutoff,
      planFingerprint: plan.planFingerprint,
      actionsFingerprint: plan.actionsFingerprint,
      intentSignature: intent.envelope.signature,
      recoveryStartedAt,
      recoveryCompletedAt: '2026-08-08T10:30:00.000Z',
      actionCount: 1,
      promotionAllowed: false,
    });
    expect(created.envelope.record.actions).toEqual([{
      executionId,
      action: 'RESTORE_ARTIFACTS_AND_ABORT',
      terminalEvidence: 'ABORTED_EXECUTION',
    }]);
    expect(created.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    const receiptPath = join(targetDir, RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME);
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(await readVerifiedRestorePrivateRecoveryReceipt(
      receiptPath,
      keyFile,
      join(targetDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME),
      plan,
      rec,
    )).toEqual(created.envelope);
  });

  it('reuses the original terminal receipt across a later already-applied retry', async () => {
    const { rec, plan, keyFile, targetDir, intent } = await fixture();
    const first = await ensureSignedRestorePrivateRecoveryReceipt({
      targetDir,
      keyFile,
      intentFile: intent.path,
      plan,
      reconciliation: rec,
      executionResult: executionResult(plan.planFingerprint, 'APPLIED'),
      completedAt: '2026-08-08T10:30:00.000Z',
    });
    const second = await ensureSignedRestorePrivateRecoveryReceipt({
      targetDir,
      keyFile,
      intentFile: intent.path,
      plan,
      reconciliation: rec,
      executionResult: executionResult(plan.planFingerprint, 'ALREADY_APPLIED'),
      completedAt: '2026-08-08T11:00:00.000Z',
    });

    expect(second.created).toBe(false);
    expect(second.envelope).toEqual(first.envelope);
    expect(second.envelope.record.recoveryCompletedAt).toBe('2026-08-08T10:30:00.000Z');
  });

  it('rejects invalid terminal evidence and detects receipt tampering', async () => {
    const { rec, plan, keyFile, targetDir, intent } = await fixture();
    const invalid = {
      ...executionResult(plan.planFingerprint),
      actions: Object.freeze([Object.freeze({
        executionId,
        action: 'RESTORE_ARTIFACTS_AND_ABORT' as const,
        status: 'APPLIED' as const,
        artifactMutationCount: 1,
        terminalEvidence: 'COMPLETED_EXECUTION' as const,
      })]),
    } satisfies RestorePrivateRecoveryExecutionResult;
    await expect(ensureSignedRestorePrivateRecoveryReceipt({
      targetDir,
      keyFile,
      intentFile: intent.path,
      plan,
      reconciliation: rec,
      executionResult: invalid,
      completedAt: '2026-08-08T10:30:00.000Z',
    })).rejects.toThrow('execution result action does not match');

    const created = await ensureSignedRestorePrivateRecoveryReceipt({
      targetDir,
      keyFile,
      intentFile: intent.path,
      plan,
      reconciliation: rec,
      executionResult: executionResult(plan.planFingerprint),
      completedAt: '2026-08-08T10:30:00.000Z',
    });
    const receiptPath = created.path;
    const parsed = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      record: { recoveryCompletedAt: string };
    };
    parsed.record.recoveryCompletedAt = '2026-08-08T12:00:00.000Z';
    await writeFile(receiptPath, `${JSON.stringify(parsed, null, 2)}\n`);

    await expect(readVerifiedRestorePrivateRecoveryReceipt(
      receiptPath,
      keyFile,
      intent.path,
      plan,
      rec,
    )).rejects.toThrow('signature verification failed');
  });
});
