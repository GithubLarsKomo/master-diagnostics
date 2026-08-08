import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import type { RestorePrivateRecoveryAssessment } from '../src/services/restore-private-recovery-assessment';
import { executeRestorePrivateRecovery } from '../src/services/restore-private-recovery-executor';
import {
  ensureSignedRestorePrivateRecoveryIntent,
  RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME,
} from '../src/services/restore-private-recovery-intent';
import { getRestorePrivateRecoveryNormalization } from '../src/services/restore-private-recovery-normalization';
import { buildRestorePrivateRecoveryPlan } from '../src/services/restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;
const stagedAt = '2026-07-31T23:55:00.000Z';
const preCutoffCommittedAt = '2026-07-31T23:59:00.000Z';
const postBackupCommittedAt = '2026-08-03T10:00:00.000Z';
const recoveryStartedAt = '2026-08-08T10:00:00.000Z';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-executor-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function storageRoots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-executor-'));
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function signingKey(workspace: string): Promise<string> {
  const keyFile = join(workspace, 'recovery-intent.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 31).toString('base64')}\n`, { mode: 0o600 });
  return keyFile;
}

async function seedBase(db: Database): Promise<void> {
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
}

async function seedExecution(
  db: Database,
  status: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED',
  withReport = true,
): Promise<void> {
  await seedBase(db);
  await db.insert(schema.athleteAnonymizationExecutions).values({
    id: executionId, tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: 'approval-a',
    executionVersion: 1, status: 'PREPARING', preparedByUserId: 'admin-a', preparedAt: createdAt,
    artifactsStagedAt: null, dbCommittedAt: null, completedAt: null, abortedAt: null,
    createdAt, updatedAt: createdAt,
  });
  if (withReport) {
    await db.insert(schema.athleteAnonymizationExecutionArtifacts).values({
      id: 'artifact-a', tenantId: 'tenant-a', executionId, kind: 'REPORT',
      storageReference: reportReference, createdAt, updatedAt: createdAt,
    });
  }
  if (status === 'PREPARING') return;
  await db.update(schema.athleteAnonymizationExecutions).set({
    status: 'ARTIFACTS_STAGED', artifactsStagedAt: stagedAt, updatedAt: stagedAt,
  }).where(eq(schema.athleteAnonymizationExecutions.id, executionId));
  if (status === 'ARTIFACTS_STAGED') return;
  await db.update(schema.athleteAnonymizationExecutions).set({
    status: 'DB_COMMITTED', dbCommittedAt: preCutoffCommittedAt, updatedAt: preCutoffCommittedAt,
  }).where(eq(schema.athleteAnonymizationExecutions.id, executionId));
}

function clearReconciliation(): Readonly<RestorePrivacyReconciliationReport> {
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

function postBackupReconciliation(): Readonly<RestorePrivacyReconciliationReport> {
  return Object.freeze({
    reportVersion: 1,
    backupCutoff: cutoff,
    status: 'REPLAY_REQUIRED',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: Object.freeze({
      generatedAt: '2026-08-08T00:00:00.000Z',
      entriesFingerprint: `sha256:${'c'.repeat(64)}`,
      entryCount: 1,
    }),
    journalMarkerCount: 2,
    obligations: Object.freeze([Object.freeze({
      tenantId: 'tenant-a', athleteId: 'athlete-a', executionId, approvalId: 'approval-a',
      deletionRequestId: 'deletion-a', executionVersion: 1, policyVersion: '1.6.0',
      scopeFingerprint, capabilityFingerprint, dbCommittedAt: postBackupCommittedAt,
      sources: Object.freeze(['LEDGER', 'JOURNAL'] as const),
    })]),
    blockers: Object.freeze([]),
  });
}

function assessment(
  snapshotStatus: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED',
  action: 'ABORT_PREPARING' | 'RESTORE_ARTIFACTS_AND_ABORT' | 'PURGE_ARTIFACTS_AND_COMPLETE' | 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE',
  counts: Readonly<{ active: number; quarantined: number; absent: number }>,
): Readonly<RestorePrivateRecoveryAssessment> {
  const postBackup = action === 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE';
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
      snapshotStatus,
      action,
      effectBasis: postBackup
        ? 'POST_BACKUP_COMMITTED'
        : snapshotStatus === 'DB_COMMITTED'
          ? 'PRE_CUTOFF_DB_COMMITTED'
          : 'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
      committedAt: postBackup ? postBackupCommittedAt : snapshotStatus === 'DB_COMMITTED' ? preCutoffCommittedAt : null,
      artifactCount: counts.active + counts.quarantined + counts.absent,
      activeArtifactCount: counts.active,
      quarantinedArtifactCount: counts.quarantined,
      absentArtifactCount: counts.absent,
    })]),
    blockers: Object.freeze([]),
  });
}

async function seedAppliedReplayAuthorization(db: Database): Promise<void> {
  await db.insert(schema.restorePrivacyReplayAuthorizations).values({
    executionId,
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    approvalId: 'approval-a',
    deletionRequestId: 'deletion-a',
    executionVersion: 1,
    policyVersion: '1.6.0',
    scopeFingerprint,
    capabilityFingerprint,
    dbCommittedAt: postBackupCommittedAt,
    status: 'ACTIVE',
    appliedAt: null,
    createdAt: '2026-08-08T08:00:00.000Z',
    updatedAt: '2026-08-08T08:00:00.000Z',
  });
  await db.update(schema.restorePrivacyReplayAuthorizations).set({
    status: 'APPLIED',
    appliedAt: '2026-08-08T09:00:00.000Z',
    updatedAt: '2026-08-08T09:00:00.000Z',
  }).where(eq(schema.restorePrivacyReplayAuthorizations.executionId, executionId));
}

async function prepareExecution(
  db: Database,
  storage: Awaited<ReturnType<typeof storageRoots>>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  recoveryAssessment: Readonly<RestorePrivateRecoveryAssessment>,
) {
  const plan = await buildRestorePrivateRecoveryPlan(db, reconciliation, recoveryAssessment, storage);
  const keyFile = await signingKey(storage.workspace);
  const intentDir = join(storage.workspace, 'recovery-execution');
  await ensureSignedRestorePrivateRecoveryIntent({
    targetDir: intentDir,
    keyFile,
    plan,
    reconciliation,
    startedAt: recoveryStartedAt,
  });
  return {
    plan,
    keyFile,
    intentFile: join(intentDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME),
  };
}

async function executionRow(db: Database) {
  const rows = await db.select().from(schema.athleteAnonymizationExecutions).where(
    eq(schema.athleteAnonymizationExecutions.id, executionId),
  ).limit(1);
  return rows[0]!;
}

describe('restore private recovery executor', () => {
  it('aborts an untouched PREPARING execution without touching active artifacts and retries idempotently', async () => {
    const db = await createTestDatabase();
    const storage = await storageRoots();
    await seedExecution(db, 'PREPARING');
    const activePath = join(storage.reportRoot, reportReference);
    await put(activePath, 'active');
    const reconciliation = clearReconciliation();
    const prepared = await prepareExecution(
      db,
      storage,
      reconciliation,
      assessment('PREPARING', 'ABORT_PREPARING', { active: 1, quarantined: 0, absent: 0 }),
    );

    const first = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    });
    expect(first).toMatchObject({ actionCount: 1, appliedCount: 1, alreadyAppliedCount: 0, promotionAllowed: false });
    expect(first.actions[0]).toMatchObject({ action: 'ABORT_PREPARING', status: 'APPLIED', artifactMutationCount: 0 });
    expect((await executionRow(db))).toMatchObject({ status: 'ABORTED', abortedAt: recoveryStartedAt });
    expect(await readFile(activePath, 'utf8')).toBe('active');

    const second = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T11:00:00.000Z',
    });
    expect(second.actions[0]).toMatchObject({ status: 'ALREADY_APPLIED', artifactMutationCount: 0 });
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'restore.anonymization_execution_aborted'));
    expect(audits).toHaveLength(1);
  });

  it('restores quarantined artifacts before abort and resumes from the restored file state', async () => {
    const db = await createTestDatabase();
    const storage = await storageRoots();
    await seedExecution(db, 'ARTIFACTS_STAGED');
    const activePath = join(storage.reportRoot, reportReference);
    const quarantinePath = join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference);
    await put(quarantinePath, 'quarantine');
    const reconciliation = clearReconciliation();
    const prepared = await prepareExecution(
      db,
      storage,
      reconciliation,
      assessment('ARTIFACTS_STAGED', 'RESTORE_ARTIFACTS_AND_ABORT', { active: 0, quarantined: 1, absent: 0 }),
    );

    const first = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    });
    expect(first.actions[0]).toMatchObject({ status: 'APPLIED', artifactMutationCount: 1 });
    expect(await readFile(activePath, 'utf8')).toBe('quarantine');
    expect(await exists(quarantinePath)).toBe(false);
    expect((await executionRow(db))).toMatchObject({ status: 'ABORTED', abortedAt: recoveryStartedAt });

    const second = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T11:00:00.000Z',
    });
    expect(second.actions[0]).toMatchObject({ status: 'ALREADY_APPLIED', artifactMutationCount: 0 });
  });

  it('purges quarantined artifacts before completing a pre-cutoff DB_COMMITTED execution', async () => {
    const db = await createTestDatabase();
    const storage = await storageRoots();
    await seedExecution(db, 'DB_COMMITTED');
    const quarantinePath = join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference);
    await put(quarantinePath, 'quarantine');
    const reconciliation = clearReconciliation();
    const prepared = await prepareExecution(
      db,
      storage,
      reconciliation,
      assessment('DB_COMMITTED', 'PURGE_ARTIFACTS_AND_COMPLETE', { active: 0, quarantined: 1, absent: 0 }),
    );

    const first = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    });
    expect(first.actions[0]).toMatchObject({ status: 'APPLIED', artifactMutationCount: 1, terminalEvidence: 'COMPLETED_EXECUTION' });
    expect(await exists(quarantinePath)).toBe(false);
    expect((await executionRow(db))).toMatchObject({ status: 'COMPLETED', completedAt: recoveryStartedAt });

    const second = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T11:00:00.000Z',
    });
    expect(second.actions[0]).toMatchObject({ status: 'ALREADY_APPLIED', artifactMutationCount: 0 });
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'restore.anonymization_execution_completed'));
    expect(audits).toHaveLength(1);
  });

  it('purges post-backup replay artifacts and records normalization without rewriting snapshot history', async () => {
    const db = await createTestDatabase();
    const storage = await storageRoots();
    await seedExecution(db, 'ARTIFACTS_STAGED');
    await seedAppliedReplayAuthorization(db);
    const quarantinePath = join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference);
    await put(quarantinePath, 'quarantine');
    const reconciliation = postBackupReconciliation();
    const prepared = await prepareExecution(
      db,
      storage,
      reconciliation,
      assessment('ARTIFACTS_STAGED', 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE', { active: 0, quarantined: 1, absent: 0 }),
    );

    const first = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    });
    expect(first.actions[0]).toMatchObject({ status: 'APPLIED', artifactMutationCount: 1, terminalEvidence: 'RESTORE_NORMALIZATION' });
    expect(await exists(quarantinePath)).toBe(false);
    expect((await executionRow(db)).status).toBe('ARTIFACTS_STAGED');
    const normalization = await getRestorePrivateRecoveryNormalization(db, executionId);
    expect(normalization).toMatchObject({
      executionId,
      recoveryStartedAt,
      normalizedAt: '2026-08-08T10:30:00.000Z',
      sourceDbCommittedAt: postBackupCommittedAt,
      planFingerprint: prepared.plan.planFingerprint,
    });

    const second = await executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T11:00:00.000Z',
    });
    expect(second.actions[0]).toMatchObject({ status: 'ALREADY_APPLIED', artifactMutationCount: 0 });
    expect(await getRestorePrivateRecoveryNormalization(db, executionId)).toEqual(normalization);
  });

  it('fails closed before a forward action when an active artifact copy exists', async () => {
    const db = await createTestDatabase();
    const storage = await storageRoots();
    await seedExecution(db, 'DB_COMMITTED');
    const quarantinePath = join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference);
    await put(quarantinePath, 'quarantine');
    const reconciliation = clearReconciliation();
    const prepared = await prepareExecution(
      db,
      storage,
      reconciliation,
      assessment('DB_COMMITTED', 'PURGE_ARTIFACTS_AND_COMPLETE', { active: 0, quarantined: 1, absent: 0 }),
    );
    await put(join(storage.reportRoot, reportReference), 'unexpected-active');

    await expect(executeRestorePrivateRecovery(db, {
      ...prepared,
      reconciliation,
      roots: storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    })).rejects.toThrow('both active and quarantined artifact copies');
    expect((await executionRow(db)).status).toBe('DB_COMMITTED');
    expect(await exists(quarantinePath)).toBe(true);
  });
});
