import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  assessRestorePrivateRecovery,
  type RestorePrivateRecoveryActionType,
} from '../src/services/restore-private-recovery-assessment';
import type {
  RestorePrivateHealthcheckBlocker,
  RestorePrivateHealthcheckReport,
  RestorePrivateTransientExecution,
} from '../src/services/restore-private-healthcheck';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const scopeFingerprint = `sha256:${'a'.repeat(64)}` as const;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}` as const;

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-recovery-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function roots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-recovery-'));
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

async function seedExecution(
  db: Database,
  status: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED',
  options: Readonly<{ withReport?: boolean; dbCommittedAt?: string | null }> = {},
): Promise<void> {
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
    executionVersion: 1, status, preparedByUserId: 'admin-a', preparedAt: createdAt,
    artifactsStagedAt: status === 'PREPARING' ? null : '2026-07-31T23:55:00.000Z',
    dbCommittedAt: status === 'DB_COMMITTED' ? (options.dbCommittedAt ?? '2026-07-31T23:59:00.000Z') : null,
    completedAt: null, abortedAt: null, createdAt, updatedAt: createdAt,
  });
  if (options.withReport) {
    await db.insert(schema.athleteAnonymizationExecutionArtifacts).values({
      id: 'artifact-a', tenantId: 'tenant-a', executionId, kind: 'REPORT',
      storageReference: reportReference, createdAt, updatedAt: createdAt,
    });
  }
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

function transient(status: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED'):
Readonly<RestorePrivateTransientExecution> {
  return Object.freeze({ executionId, tenantId: 'tenant-a', athleteId: 'athlete-a', status });
}

function healthBlocker(
  code: RestorePrivateHealthcheckBlocker['code'],
  options: Readonly<{
    reference?: string | null;
    status?: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED' | null;
    execution?: string | null;
  }> = {},
): Readonly<RestorePrivateHealthcheckBlocker> {
  return Object.freeze({
    code,
    kind: options.reference ? 'REPORT' : null,
    reference: options.reference ?? null,
    executionId: options.execution ?? (code === 'ACTIVE_ARTIFACT_MISSING' ? null : executionId),
    executionStatus: options.status ?? null,
  });
}

function healthcheck(
  reconciliationStatus: 'CLEAR' | 'REPLAY_REQUIRED',
  transientExecutions: readonly Readonly<RestorePrivateTransientExecution>[],
  blockers: readonly Readonly<RestorePrivateHealthcheckBlocker>[],
): Readonly<RestorePrivateHealthcheckReport> {
  return Object.freeze({
    healthcheckVersion: 1,
    backupCutoff: cutoff,
    status: blockers.length === 0 ? 'HEALTHY' : 'BLOCKED',
    healthcheckPassed: blockers.length === 0,
    readyForPromotionReview: blockers.length === 0,
    promotionAllowed: false,
    reconciliationStatus,
    databaseStatus: 'DATABASE_SATISFIED',
    artifactManifestVerified: true,
    artifactReplayVerified: true,
    storage: Object.freeze([]),
    transientExecutions: Object.freeze(transientExecutions),
    blockers: Object.freeze(blockers),
  });
}

async function expectAction(
  status: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED',
  action: RestorePrivateRecoveryActionType,
  options: Readonly<{
    postBackupCommitted?: boolean;
    withReport?: boolean;
    quarantine?: boolean;
    active?: boolean;
    dbCommittedAt?: string | null;
  }> = {},
) {
  const db = await createTestDatabase();
  const storage = await roots();
  await seedExecution(db, status, {
    withReport: options.withReport,
    dbCommittedAt: options.dbCommittedAt,
  });
  if (options.active) await put(join(storage.reportRoot, reportReference), 'active');
  if (options.quarantine) {
    await put(join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference), 'quarantine');
  }

  const blockers: RestorePrivateHealthcheckBlocker[] = [healthBlocker(
    'ANONYMIZATION_EXECUTION_TRANSIENT',
    { status },
  )];
  if (options.withReport && !options.active) blockers.push(healthBlocker('ACTIVE_ARTIFACT_MISSING', {
    reference: reportReference,
    execution: null,
  }));
  if (options.quarantine) blockers.push(healthBlocker('ANONYMIZATION_QUARANTINE_NOT_EMPTY', {
    reference: `.anonymization-quarantine/${executionId}/${reportReference}`,
  }));

  const rec = reconciliation(Boolean(options.postBackupCommitted));
  const assessment = await assessRestorePrivateRecovery(
    db,
    rec,
    healthcheck(rec.status as 'CLEAR' | 'REPLAY_REQUIRED', [transient(status)], blockers),
    storage,
  );
  expect(assessment.status).toBe('RECOVERY_READY');
  expect(assessment.promotionAllowed).toBe(false);
  expect(assessment.blockers).toEqual([]);
  expect(assessment.actions).toHaveLength(1);
  expect(assessment.actions[0]).toMatchObject({ executionId, action });
  return { assessment, storage };
}

describe('restore private recovery assessment', () => {
  it('requires no recovery for an already healthy private restore', async () => {
    const db = await createTestDatabase();
    const storage = await roots();
    const rec = reconciliation(false);
    const assessment = await assessRestorePrivateRecovery(
      db,
      rec,
      healthcheck('CLEAR', [], []),
      storage,
    );
    expect(assessment).toMatchObject({
      assessmentVersion: 1,
      status: 'NOT_REQUIRED',
      recoveryRequired: false,
      recoveryReady: false,
      promotionAllowed: false,
      actions: [],
      blockers: [],
    });
  });

  it('classifies an untouched PREPARING snapshot as abort-only', async () => {
    const { assessment } = await expectAction('PREPARING', 'ABORT_PREPARING');
    expect(assessment.actions[0]).toMatchObject({
      effectBasis: 'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
      artifactCount: 0,
      committedAt: null,
    });
  });

  it('restores staged artifacts before aborting when no committed effect exists', async () => {
    const { assessment, storage } = await expectAction('ARTIFACTS_STAGED', 'RESTORE_ARTIFACTS_AND_ABORT', {
      withReport: true,
      quarantine: true,
    });
    expect(assessment.actions[0]).toMatchObject({
      effectBasis: 'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
      activeArtifactCount: 0,
      quarantinedArtifactCount: 1,
      absentArtifactCount: 0,
    });
    expect(await readFile(
      join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference),
      'utf8',
    )).toBe('quarantine');
  });

  it('finishes a pre-cutoff DB_COMMITTED snapshot only in the forward direction', async () => {
    const { assessment } = await expectAction('DB_COMMITTED', 'PURGE_ARTIFACTS_AND_COMPLETE', {
      withReport: true,
      quarantine: true,
      dbCommittedAt: '2026-07-31T23:59:00.000Z',
    });
    expect(assessment.actions[0]).toMatchObject({
      effectBasis: 'PRE_CUTOFF_DB_COMMITTED',
      committedAt: '2026-07-31T23:59:00.000Z',
      quarantinedArtifactCount: 1,
    });
  });

  it('never rolls back ARTIFACTS_STAGED when the same execution committed after backup', async () => {
    const { assessment, storage } = await expectAction(
      'ARTIFACTS_STAGED',
      'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE',
      { postBackupCommitted: true, withReport: true, quarantine: true },
    );
    expect(assessment.actions[0]).toMatchObject({
      effectBasis: 'POST_BACKUP_COMMITTED',
      committedAt: '2026-08-03T10:00:00.000Z',
      activeArtifactCount: 0,
      quarantinedArtifactCount: 1,
    });
    expect(await readFile(
      join(storage.reportRoot, '.anonymization-quarantine', executionId, reportReference),
      'utf8',
    )).toBe('quarantine');
  });

  it('blocks quarantine entries that are not bound to the execution artifact manifest', async () => {
    const db = await createTestDatabase();
    const storage = await roots();
    await seedExecution(db, 'ARTIFACTS_STAGED');
    const unknown = '.anonymization-quarantine/11111111-1111-4111-8111-111111111111/tenant-a/test-a/de/unknown.pdf';
    await put(join(storage.reportRoot, unknown), 'unknown');
    const rec = reconciliation(false);
    const assessment = await assessRestorePrivateRecovery(
      db,
      rec,
      healthcheck('CLEAR', [transient('ARTIFACTS_STAGED')], [
        healthBlocker('ANONYMIZATION_EXECUTION_TRANSIENT', { status: 'ARTIFACTS_STAGED' }),
        healthBlocker('ANONYMIZATION_QUARANTINE_NOT_EMPTY', { reference: unknown }),
      ]),
      storage,
    );
    expect(assessment.status).toBe('BLOCKED');
    expect(assessment.actions).toEqual([]);
    expect(assessment.blockers).toContainEqual({
      code: 'QUARANTINE_NOT_IN_EXECUTION_MANIFEST',
      executionId,
      healthcheckCode: null,
      kind: 'REPORT',
      reference: unknown,
    });
    expect(await readFile(join(storage.reportRoot, unknown), 'utf8')).toBe('unknown');
  });
});
