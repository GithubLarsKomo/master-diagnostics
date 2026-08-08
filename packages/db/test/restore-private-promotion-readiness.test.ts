import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  restorePrivacyArtifactReplayResultForManifest,
} from '../src/services/restore-privacy-artifact-replay';
import {
  buildRestorePrivacyArtifactReplayManifest,
} from '../src/services/restore-privacy-artifact-replay-manifest';
import type { RestorePrivateRecoveryAssessment } from '../src/services/restore-private-recovery-assessment';
import { executeRestorePrivateRecovery } from '../src/services/restore-private-recovery-executor';
import {
  ensureSignedRestorePrivateRecoveryIntent,
  RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME,
} from '../src/services/restore-private-recovery-intent';
import { buildRestorePrivateRecoveryPlan } from '../src/services/restore-private-recovery-plan';
import {
  assessRestorePrivatePromotionReadiness,
} from '../src/services/restore-private-promotion-readiness';
import {
  ensureSignedRestorePrivateRecoveryReceipt,
  RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME,
} from '../src/services/restore-private-recovery-receipt';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const stagedAt = '2026-07-31T23:55:00.000Z';
const committedAt = '2026-07-31T23:59:00.000Z';
const recoveryStartedAt = '2026-08-08T10:00:00.000Z';
const recoveryCompletedAt = '2026-08-08T10:30:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-promotion-readiness-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function storageRoots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-promotion-readiness-'));
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

function recoveryAssessment(): Readonly<RestorePrivateRecoveryAssessment> {
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
      snapshotStatus: 'DB_COMMITTED',
      action: 'PURGE_ARTIFACTS_AND_COMPLETE',
      effectBasis: 'PRE_CUTOFF_DB_COMMITTED',
      committedAt,
      artifactCount: 1,
      activeArtifactCount: 0,
      quarantinedArtifactCount: 1,
      absentArtifactCount: 0,
    })]),
    blockers: Object.freeze([]),
  });
}

async function seedCommittedExecution(db: Database): Promise<void> {
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
    status: 'ARTIFACTS_STAGED', artifactsStagedAt: stagedAt, updatedAt: stagedAt,
  }).where(eq(schema.athleteAnonymizationExecutions.id, executionId));
  await db.update(schema.athleteAnonymizationExecutions).set({
    status: 'DB_COMMITTED', dbCommittedAt: committedAt, updatedAt: committedAt,
  }).where(eq(schema.athleteAnonymizationExecutions.id, executionId));
}

async function emptyReplayEvidence(db: Database, rec: Readonly<RestorePrivacyReconciliationReport>) {
  const manifest = await buildRestorePrivacyArtifactReplayManifest(db, rec);
  return { manifest, result: restorePrivacyArtifactReplayResultForManifest(manifest) };
}

async function completeRecoveryFixture() {
  const db = await createTestDatabase();
  const roots = await storageRoots();
  const rec = reconciliation();
  await seedCommittedExecution(db);
  await put(join(roots.reportRoot, '.anonymization-quarantine', executionId, reportReference), 'quarantine');
  const plan = await buildRestorePrivateRecoveryPlan(db, rec, recoveryAssessment(), roots);
  const keyFile = join(roots.workspace, 'recovery.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 41).toString('base64')}\n`, { mode: 0o600 });
  const executionDir = join(roots.workspace, 'recovery-execution');
  const intent = await ensureSignedRestorePrivateRecoveryIntent({
    targetDir: executionDir,
    keyFile,
    plan,
    reconciliation: rec,
    startedAt: recoveryStartedAt,
  });
  const executionResult = await executeRestorePrivateRecovery(db, {
    plan,
    reconciliation: rec,
    intentFile: intent.path,
    intentKeyFile: keyFile,
    roots,
    normalizedAt: recoveryCompletedAt,
  });
  const receipt = await ensureSignedRestorePrivateRecoveryReceipt({
    targetDir: executionDir,
    keyFile,
    intentFile: intent.path,
    plan,
    reconciliation: rec,
    executionResult,
    completedAt: recoveryCompletedAt,
  });
  const replay = await emptyReplayEvidence(db, rec);
  return {
    db,
    roots,
    rec,
    replay,
    plan,
    keyFile,
    intentFile: join(executionDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME),
    receiptFile: join(executionDir, RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME),
    receipt,
  };
}

const noRecoveryEvidence = Object.freeze({
  plan: null,
  intentFile: null,
  receiptFile: null,
  keyFile: null,
});

describe('restore private promotion readiness', () => {
  it('authorizes a clean healthy restore without recovery evidence', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    const rec = reconciliation();
    const replay = await emptyReplayEvidence(db, rec);

    const report = await assessRestorePrivatePromotionReadiness(
      db, rec, replay.manifest, replay.result, roots, noRecoveryEvidence,
    );

    expect(report).toMatchObject({
      readinessVersion: 1,
      backupCutoff: cutoff,
      status: 'PROMOTION_READY',
      promotionAllowed: true,
      authorizationScope: 'PRIVATE_RESTORE_PROMOTION',
      recoveryEvidenceStatus: 'NOT_REQUIRED',
      recoveryPlanFingerprint: null,
      recoveryIntentSignature: null,
      recoveryReceiptSignature: null,
      recoveryCompletedAt: null,
      blockers: [],
    });
    expect(report.healthcheck).toMatchObject({ status: 'HEALTHY', readyForPromotionReview: true, promotionAllowed: false });
    expect(report.healthcheckFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.evidenceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('requires and verifies the signed completion receipt after current restore recovery', async () => {
    const fixture = await completeRecoveryFixture();

    const missing = await assessRestorePrivatePromotionReadiness(
      fixture.db,
      fixture.rec,
      fixture.replay.manifest,
      fixture.replay.result,
      fixture.roots,
      noRecoveryEvidence,
    );
    expect(missing).toMatchObject({
      status: 'BLOCKED',
      promotionAllowed: false,
      recoveryEvidenceStatus: 'MISSING',
    });
    expect(missing.blockers.map((item) => item.code)).toContain('RECOVERY_EVIDENCE_REQUIRED');

    const verified = await assessRestorePrivatePromotionReadiness(
      fixture.db,
      fixture.rec,
      fixture.replay.manifest,
      fixture.replay.result,
      fixture.roots,
      {
        plan: fixture.plan,
        intentFile: fixture.intentFile,
        receiptFile: fixture.receiptFile,
        keyFile: fixture.keyFile,
      },
    );
    expect(verified).toMatchObject({
      status: 'PROMOTION_READY',
      promotionAllowed: true,
      recoveryEvidenceStatus: 'VERIFIED',
      recoveryPlanFingerprint: fixture.plan.planFingerprint,
      recoveryIntentSignature: fixture.receipt.envelope.record.intentSignature,
      recoveryReceiptSignature: fixture.receipt.envelope.signature,
      recoveryCompletedAt,
      blockers: [],
    });
    expect(verified.healthcheck).toMatchObject({ status: 'HEALTHY', readyForPromotionReview: true });
  });

  it('fails closed for incomplete or tampered recovery evidence', async () => {
    const fixture = await completeRecoveryFixture();

    const incomplete = await assessRestorePrivatePromotionReadiness(
      fixture.db,
      fixture.rec,
      fixture.replay.manifest,
      fixture.replay.result,
      fixture.roots,
      { plan: fixture.plan, intentFile: fixture.intentFile, receiptFile: null, keyFile: fixture.keyFile },
    );
    expect(incomplete.blockers.map((item) => item.code)).toContain('RECOVERY_EVIDENCE_INCOMPLETE');
    expect(incomplete.promotionAllowed).toBe(false);

    await writeFile(fixture.receiptFile, '{"tampered":true}\n');
    const tampered = await assessRestorePrivatePromotionReadiness(
      fixture.db,
      fixture.rec,
      fixture.replay.manifest,
      fixture.replay.result,
      fixture.roots,
      {
        plan: fixture.plan,
        intentFile: fixture.intentFile,
        receiptFile: fixture.receiptFile,
        keyFile: fixture.keyFile,
      },
    );
    expect(tampered.blockers.map((item) => item.code)).toContain('RECOVERY_EVIDENCE_INVALID');
    expect(tampered.promotionAllowed).toBe(false);
  });

  it('never authorizes an unhealthy private restore even when no recovery evidence is present', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    const rec = reconciliation();
    await seedCommittedExecution(db);
    const replay = await emptyReplayEvidence(db, rec);

    const report = await assessRestorePrivatePromotionReadiness(
      db, rec, replay.manifest, replay.result, roots, noRecoveryEvidence,
    );
    expect(report.status).toBe('BLOCKED');
    expect(report.promotionAllowed).toBe(false);
    expect(report.blockers.map((item) => item.code)).toContain('HEALTHCHECK_NOT_HEALTHY');
  });
});
