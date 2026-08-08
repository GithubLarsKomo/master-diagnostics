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
import { restorePrivacyArtifactReplayResultForManifest } from '../src/services/restore-privacy-artifact-replay';
import { buildRestorePrivacyArtifactReplayManifest } from '../src/services/restore-privacy-artifact-replay-manifest';
import { prepareRestorePrivateRecoveryPlan } from '../src/services/restore-private-recovery-planning';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-planning-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function roots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-planning-'));
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

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
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

async function replayEvidence(db: Database, reconciliation: Readonly<RestorePrivacyReconciliationReport>) {
  const manifest = await buildRestorePrivacyArtifactReplayManifest(db, reconciliation);
  return {
    manifest,
    result: restorePrivacyArtifactReplayResultForManifest(manifest),
  };
}

describe('restore private recovery planning', () => {
  it('persists a deterministic plan only for a recoverable private restore', async () => {
    const db = await createTestDatabase();
    const storage = await roots();
    const reconciliation = clearReconciliation();
    await seedArtifactsStagedExecution(db);
    await put(join(
      storage.reportRoot,
      '.anonymization-quarantine',
      executionId,
      reportReference,
    ), 'quarantine');
    const evidence = await replayEvidence(db, reconciliation);
    const planFile = join(storage.workspace, 'recovery-plan.json');

    const first = await prepareRestorePrivateRecoveryPlan(
      db,
      reconciliation,
      evidence.manifest,
      evidence.result,
      storage,
      planFile,
    );
    expect(first).toMatchObject({
      status: 'PLAN_READY',
      promotionAllowed: false,
      planCreated: true,
      healthcheck: { status: 'BLOCKED' },
      assessment: { status: 'RECOVERY_READY' },
      plan: { actionCount: 1, promotionAllowed: false },
    });
    expect(first.plan?.actions[0]).toMatchObject({
      executionId,
      action: 'RESTORE_ARTIFACTS_AND_ABORT',
      artifacts: [{ storageReference: reportReference, expectedPresence: 'QUARANTINED' }],
    });

    const firstBytes = await readFile(planFile, 'utf8');
    const second = await prepareRestorePrivateRecoveryPlan(
      db,
      reconciliation,
      evidence.manifest,
      evidence.result,
      storage,
      planFile,
    );
    expect(second.status).toBe('PLAN_READY');
    expect(second.planCreated).toBe(false);
    expect(await readFile(planFile, 'utf8')).toBe(firstBytes);
  });

  it('does not create a plan when the private restore is already healthy', async () => {
    const db = await createTestDatabase();
    const storage = await roots();
    const reconciliation = clearReconciliation();
    const evidence = await replayEvidence(db, reconciliation);
    const planFile = join(storage.workspace, 'recovery-plan.json');

    const result = await prepareRestorePrivateRecoveryPlan(
      db,
      reconciliation,
      evidence.manifest,
      evidence.result,
      storage,
      planFile,
    );
    expect(result).toMatchObject({
      status: 'NOT_REQUIRED',
      planCreated: false,
      plan: null,
      healthcheck: { status: 'HEALTHY' },
      assessment: { status: 'NOT_REQUIRED' },
      promotionAllowed: false,
    });
    await expectMissing(planFile);
  });

  it('fails closed without a plan for non-recoverable healthcheck blockers', async () => {
    const db = await createTestDatabase();
    const storage = await roots();
    const reconciliation = clearReconciliation();
    const evidence = await replayEvidence(db, reconciliation);
    const planFile = join(storage.workspace, 'recovery-plan.json');
    await put(join(storage.reportRoot, 'orphan.pdf'), 'orphan');

    const result = await prepareRestorePrivateRecoveryPlan(
      db,
      reconciliation,
      evidence.manifest,
      evidence.result,
      storage,
      planFile,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.planCreated).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.assessment.status).toBe('BLOCKED');
    expect(result.assessment.blockers).toContainEqual(expect.objectContaining({
      code: 'HEALTHCHECK_BLOCKER_NOT_RECOVERABLE',
      healthcheckCode: 'ACTIVE_ARTIFACT_ORPHANED',
    }));
    await expectMissing(planFile);
  });
});
