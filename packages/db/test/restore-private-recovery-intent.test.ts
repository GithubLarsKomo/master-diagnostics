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
  ensureSignedRestorePrivateRecoveryIntent,
  readVerifiedRestorePrivateRecoveryIntent,
  RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME,
} from '../src/services/restore-private-recovery-intent';
import { buildRestorePrivateRecoveryPlan } from '../src/services/restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-intent-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function roots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-intent-'));
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
  await writeFile(keyFile, `${Buffer.alloc(32, 17).toString('base64')}\n`, { mode: 0o600 });
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
  return { db, storage, rec, plan, keyFile: await signingKey(storage.workspace) };
}

describe('restore private recovery intent', () => {
  it('persists a signed private PENDING intent and reuses its original startedAt on retry', async () => {
    const { storage, rec, plan, keyFile } = await fixture();
    const targetDir = join(storage.workspace, 'recovery-execution');
    const first = await ensureSignedRestorePrivateRecoveryIntent({
      targetDir,
      keyFile,
      plan,
      reconciliation: rec,
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    expect(first.created).toBe(true);
    expect(first.envelope.record).toMatchObject({
      intentVersion: 1,
      phase: 'PENDING',
      startedAt: '2026-08-08T10:00:00.000Z',
      backupCutoff: cutoff,
      planFingerprint: plan.planFingerprint,
      actionsFingerprint: plan.actionsFingerprint,
      actionCount: 1,
      promotionAllowed: false,
    });
    expect(first.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    const second = await ensureSignedRestorePrivateRecoveryIntent({
      targetDir,
      keyFile,
      plan,
      reconciliation: rec,
      startedAt: '2026-08-08T11:00:00.000Z',
    });
    expect(second.created).toBe(false);
    expect(second.envelope.record.startedAt).toBe('2026-08-08T10:00:00.000Z');
    const intentPath = join(targetDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME);
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(intentPath)).mode & 0o777).toBe(0o600);
    expect(await readVerifiedRestorePrivateRecoveryIntent(intentPath, keyFile, plan, rec))
      .toEqual(first.envelope);
  });

  it('concurrent creators converge on one valid recovery timestamp for the same plan', async () => {
    const { storage, rec, plan, keyFile } = await fixture();
    const targetDir = join(storage.workspace, 'recovery-execution');
    const [left, right] = await Promise.all([
      ensureSignedRestorePrivateRecoveryIntent({
        targetDir,
        keyFile,
        plan,
        reconciliation: rec,
        startedAt: '2026-08-08T10:00:00.000Z',
      }),
      ensureSignedRestorePrivateRecoveryIntent({
        targetDir,
        keyFile,
        plan,
        reconciliation: rec,
        startedAt: '2026-08-08T10:00:01.000Z',
      }),
    ]);
    expect(left.envelope).toEqual(right.envelope);
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
  });

  it('rejects stale timing, tampering and a changed reconciliation binding', async () => {
    const { storage, rec, plan, keyFile } = await fixture();
    const targetDir = join(storage.workspace, 'recovery-execution');
    await expect(ensureSignedRestorePrivateRecoveryIntent({
      targetDir,
      keyFile,
      plan,
      reconciliation: rec,
      startedAt: '2026-08-07T23:59:59.999Z',
    })).rejects.toThrow('must not precede the reconciliation ledger evidence');

    const created = await ensureSignedRestorePrivateRecoveryIntent({
      targetDir,
      keyFile,
      plan,
      reconciliation: rec,
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    const intentPath = created.path;
    const parsed = JSON.parse(await readFile(intentPath, 'utf8')) as {
      signature: string;
      record: { startedAt: string };
    };
    parsed.record.startedAt = '2026-08-08T12:00:00.000Z';
    await writeFile(intentPath, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivateRecoveryIntent(intentPath, keyFile, plan, rec))
      .rejects.toThrow('signature verification failed');

    await writeFile(intentPath, `${JSON.stringify(created.envelope, null, 2)}\n`);
    await expect(readVerifiedRestorePrivateRecoveryIntent(intentPath, keyFile, plan, {
      ...rec,
      journalMarkerCount: 1,
    })).rejects.toThrow('evidence binding does not match reconciliation');
  });
});
