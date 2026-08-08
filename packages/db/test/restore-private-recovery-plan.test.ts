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
import {
  buildRestorePrivateRecoveryPlan,
  persistRestorePrivateRecoveryPlan,
  readVerifiedRestorePrivateRecoveryPlanIfPresent,
  verifyRestorePrivateRecoveryPlan,
} from '../src/services/restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-plan-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function storageRoots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-plan-'));
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

function reconciliation(postBackupCommitted = false): Readonly<RestorePrivacyReconciliationReport> {
  return Object.freeze({
    reportVersion: 1,
    backupCutoff: cutoff,
    status: postBackupCommitted ? 'REPLAY_REQUIRED' : 'CLEAR',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: Object.freeze({
      generatedAt: '2026-08-08T00:00:00.000Z',
      entriesFingerprint: `sha256:${'c'.repeat(64)}`,
      entryCount: postBackupCommitted ? 1 : 0,
    }),
    journalMarkerCount: postBackupCommitted ? 2 : 0,
    obligations: postBackupCommitted ? Object.freeze([Object.freeze({
      tenantId: 'tenant-a', athleteId: 'athlete-a', executionId, approvalId: 'approval-a',
      deletionRequestId: 'deletion-a', executionVersion: 1, policyVersion: '1.6.0',
      scopeFingerprint, capabilityFingerprint, dbCommittedAt: '2026-08-03T10:00:00.000Z',
      sources: Object.freeze(['LEDGER', 'JOURNAL'] as const),
    })]) : Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

function assessment(postBackupCommitted = false): Readonly<RestorePrivateRecoveryAssessment> {
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
      action: postBackupCommitted
        ? 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE'
        : 'RESTORE_ARTIFACTS_AND_ABORT',
      effectBasis: postBackupCommitted ? 'POST_BACKUP_COMMITTED' : 'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
      committedAt: postBackupCommitted ? '2026-08-03T10:00:00.000Z' : null,
      artifactCount: 1,
      activeArtifactCount: 0,
      quarantinedArtifactCount: 1,
      absentArtifactCount: 0,
    })]),
    blockers: Object.freeze([]),
  });
}

describe('restore private recovery plan', () => {
  it('captures exact quarantine state and persists byte-identical retries with private modes', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    await seedArtifactsStagedExecution(db);
    await put(join(roots.reportRoot, '.anonymization-quarantine', executionId, reportReference), 'quarantine');

    const rec = reconciliation(false);
    const assessed = assessment(false);
    const plan = await buildRestorePrivateRecoveryPlan(db, rec, assessed, roots);
    expect(plan).toMatchObject({
      planVersion: 1,
      backupCutoff: cutoff,
      reconciliationStatus: 'CLEAR',
      actionCount: 1,
      promotionAllowed: false,
    });
    expect(plan.actions[0]).toMatchObject({
      executionId,
      action: 'RESTORE_ARTIFACTS_AND_ABORT',
      artifactCount: 1,
      artifacts: [{
        kind: 'REPORT',
        storageReference: reportReference,
        expectedPresence: 'QUARANTINED',
      }],
    });
    expect(plan.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const planPath = join(roots.workspace, 'recovery-plan', 'recovery-plan.json');
    const first = await persistRestorePrivateRecoveryPlan(planPath, plan);
    const firstBytes = await readFile(planPath, 'utf8');
    const second = await persistRestorePrivateRecoveryPlan(planPath, plan);
    const secondBytes = await readFile(planPath, 'utf8');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(secondBytes).toBe(firstBytes);
    expect((await stat(dirname(planPath))).mode & 0o777).toBe(0o700);
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);

    const readBack = await readVerifiedRestorePrivateRecoveryPlanIfPresent(planPath, rec);
    expect(readBack).toEqual(plan);

    await expect(persistRestorePrivateRecoveryPlan(planPath, {
      ...plan,
      planFingerprint: `sha256:${'f'.repeat(64)}`,
    })).rejects.toThrow('already exists with different content');
  });

  it('binds signed post-backup COMMITTED evidence to a forward-only durable plan', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    await seedArtifactsStagedExecution(db);
    await put(join(roots.reportRoot, '.anonymization-quarantine', executionId, reportReference), 'quarantine');

    const rec = reconciliation(true);
    const plan = await buildRestorePrivateRecoveryPlan(db, rec, assessment(true), roots);
    expect(plan.reconciliationStatus).toBe('REPLAY_REQUIRED');
    expect(plan.actions[0]).toMatchObject({
      action: 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE',
      effectBasis: 'POST_BACKUP_COMMITTED',
      committedAt: '2026-08-03T10:00:00.000Z',
      artifacts: [{ expectedPresence: 'QUARANTINED' }],
    });

    verifyRestorePrivateRecoveryPlan(plan, rec);
    await expect(Promise.resolve().then(() => verifyRestorePrivateRecoveryPlan(plan, {
      ...rec,
      journalMarkerCount: rec.journalMarkerCount + 1,
    }))).rejects.toThrow('evidence binding does not match reconciliation');
  });

  it('rejects tampered plans and refuses to plan a non-ready assessment', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    await seedArtifactsStagedExecution(db);
    await put(join(roots.reportRoot, '.anonymization-quarantine', executionId, reportReference), 'quarantine');

    const rec = reconciliation(false);
    const ready = assessment(false);
    const plan = await buildRestorePrivateRecoveryPlan(db, rec, ready, roots);
    const action = plan.actions[0]!;
    const artifact = action.artifacts[0]!;
    expect(() => verifyRestorePrivateRecoveryPlan({
      ...plan,
      actions: [{
        ...action,
        artifacts: [{ ...artifact, expectedPresence: 'ACTIVE' }],
      }],
    }, rec)).toThrow();

    const notRequired: RestorePrivateRecoveryAssessment = {
      assessmentVersion: 1,
      backupCutoff: cutoff,
      status: 'NOT_REQUIRED',
      recoveryRequired: false,
      recoveryReady: false,
      promotionAllowed: false,
      actions: [],
      blockers: [],
    };
    await expect(buildRestorePrivateRecoveryPlan(db, rec, notRequired, roots))
      .rejects.toThrow('requires an unblocked RECOVERY_READY assessment');
  });
});
