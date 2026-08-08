import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import type { RestorePrivateRecoveryAssessment } from '../src/services/restore-private-recovery-assessment';
import {
  ensureSignedRestorePrivateRecoveryIntent,
  RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME,
} from '../src/services/restore-private-recovery-intent';
import {
  getRestorePrivateRecoveryNormalization,
  recordRestorePrivateRecoveryNormalization,
} from '../src/services/restore-private-recovery-normalization';
import { buildRestorePrivateRecoveryPlan } from '../src/services/restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;
const dbCommittedAt = '2026-08-03T10:00:00.000Z';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-normalization-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function roots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-normalization-'));
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
      scopeFingerprint, capabilityFingerprint, dbCommittedAt,
      sources: Object.freeze(['LEDGER', 'JOURNAL'] as const),
    })]),
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
      action: 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE',
      effectBasis: 'POST_BACKUP_COMMITTED',
      committedAt: dbCommittedAt,
      artifactCount: 1,
      activeArtifactCount: 0,
      quarantinedArtifactCount: 1,
      absentArtifactCount: 0,
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
    dbCommittedAt,
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

async function fixture(options: Readonly<{ appliedReplay?: boolean }> = {}) {
  const db = await createTestDatabase();
  const storage = await roots();
  await seedArtifactsStagedExecution(db);
  const quarantinePath = join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference);
  await put(quarantinePath, 'quarantine');
  if (options.appliedReplay !== false) await seedAppliedReplayAuthorization(db);
  const rec = reconciliation();
  const plan = await buildRestorePrivateRecoveryPlan(db, rec, assessment(), storage);
  const keyFile = await signingKey(storage.workspace);
  const intentDir = join(storage.workspace, 'recovery-execution');
  await ensureSignedRestorePrivateRecoveryIntent({
    targetDir: intentDir,
    keyFile,
    plan,
    reconciliation: rec,
    startedAt: '2026-08-08T10:00:00.000Z',
  });
  return {
    db,
    storage,
    quarantinePath,
    rec,
    plan,
    keyFile,
    intentFile: join(intentDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME),
  };
}

describe('restore private recovery normalization', () => {
  it('records immutable terminal evidence only after planned artifacts are absent', async () => {
    const state = await fixture();
    await expect(recordRestorePrivateRecoveryNormalization(state.db, {
      executionId,
      plan: state.plan,
      reconciliation: state.rec,
      intentFile: state.intentFile,
      intentKeyFile: state.keyFile,
      roots: state.storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    })).rejects.toThrow('requires all planned artifacts to be absent');

    await rm(state.quarantinePath);
    const first = await recordRestorePrivateRecoveryNormalization(state.db, {
      executionId,
      plan: state.plan,
      reconciliation: state.rec,
      intentFile: state.intentFile,
      intentKeyFile: state.keyFile,
      roots: state.storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    });
    expect(first.created).toBe(true);
    expect(first.normalization).toMatchObject({
      executionId,
      snapshotStatus: 'ARTIFACTS_STAGED',
      action: 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE',
      effectBasis: 'POST_BACKUP_COMMITTED',
      sourceDbCommittedAt: dbCommittedAt,
      recoveryStartedAt: '2026-08-08T10:00:00.000Z',
      normalizedAt: '2026-08-08T10:30:00.000Z',
      planFingerprint: state.plan.planFingerprint,
      actionsFingerprint: state.plan.actionsFingerprint,
    });

    const second = await recordRestorePrivateRecoveryNormalization(state.db, {
      executionId,
      plan: state.plan,
      reconciliation: state.rec,
      intentFile: state.intentFile,
      intentKeyFile: state.keyFile,
      roots: state.storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    });
    expect(second.created).toBe(false);
    expect(second.normalization).toEqual(first.normalization);
    expect(await getRestorePrivateRecoveryNormalization(state.db, executionId)).toEqual(first.normalization);

    const execution = await state.db.select().from(schema.athleteAnonymizationExecutions).where(
      eq(schema.athleteAnonymizationExecutions.id, executionId),
    ).limit(1);
    expect(execution[0]?.status).toBe('ARTIFACTS_STAGED');

    await expect(state.db.update(schema.restorePrivateRecoveryNormalizations).set({
      normalizedAt: '2026-08-08T11:00:00.000Z',
    }).where(eq(schema.restorePrivateRecoveryNormalizations.executionId, executionId)))
      .rejects.toThrow('restore private recovery normalizations are immutable');
    await expect(state.db.delete(schema.restorePrivateRecoveryNormalizations).where(
      eq(schema.restorePrivateRecoveryNormalizations.executionId, executionId),
    )).rejects.toThrow('restore private recovery normalizations are immutable');
  });

  it('requires the matching restore DB replay to be APPLIED', async () => {
    const state = await fixture({ appliedReplay: false });
    await rm(state.quarantinePath);
    await expect(recordRestorePrivateRecoveryNormalization(state.db, {
      executionId,
      plan: state.plan,
      reconciliation: state.rec,
      intentFile: state.intentFile,
      intentKeyFile: state.keyFile,
      roots: state.storage,
      normalizedAt: '2026-08-08T10:30:00.000Z',
    })).rejects.toThrow('applied restore privacy replay authorization required for restore normalization');
    expect(await getRestorePrivateRecoveryNormalization(state.db, executionId)).toBeNull();
  });

  it('rejects a normalization timestamp before the signed recovery intent', async () => {
    const state = await fixture();
    await rm(state.quarantinePath);
    await expect(recordRestorePrivateRecoveryNormalization(state.db, {
      executionId,
      plan: state.plan,
      reconciliation: state.rec,
      intentFile: state.intentFile,
      intentKeyFile: state.keyFile,
      roots: state.storage,
      normalizedAt: '2026-08-08T09:59:59.999Z',
    })).rejects.toThrow('must not precede its signed recovery intent');
  });
});
