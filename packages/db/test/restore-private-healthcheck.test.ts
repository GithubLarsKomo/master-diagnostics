import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { approveAthleteAnonymization } from '../src/services/anonymization-approval';
import { prepareAthleteAnonymizationExecution } from '../src/services/anonymization-execution';
import { restorePrivacyArtifactReplayResultForManifest } from '../src/services/restore-privacy-artifact-replay';
import { buildRestorePrivacyArtifactReplayManifest } from '../src/services/restore-privacy-artifact-replay-manifest';
import { assessRestorePrivateHealthcheck } from '../src/services/restore-private-healthcheck';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';
import type { GlobalPrivacyCapabilities } from '../src/services/global-privacy-policy';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-healthcheck-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function storageRoots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-healthcheck-'));
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

function clearReconciliation(): Readonly<RestorePrivacyReconciliationReport> {
  return Object.freeze({
    reportVersion: 1,
    backupCutoff: '2026-08-01T00:00:00.000Z',
    status: 'CLEAR',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: Object.freeze({
      generatedAt: '2026-08-08T00:00:00.000Z',
      entriesFingerprint: `sha256:${'1'.repeat(64)}`,
      entryCount: 0,
    }),
    journalMarkerCount: 0,
    obligations: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

async function evidence(db: Database, reconciliation: Readonly<RestorePrivacyReconciliationReport>) {
  const manifest = await buildRestorePrivacyArtifactReplayManifest(db, reconciliation);
  return { manifest, result: restorePrivacyArtifactReplayResultForManifest(manifest) };
}

async function put(path: string, value = 'artifact'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

const disabledCapabilities: GlobalPrivacyCapabilities = {
  backup: { state: 'DISABLED' },
  notifications: { state: 'DISABLED' },
};
const adminActor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};

async function seedReadyAthlete(db: Database): Promise<void> {
  const createdAt = '2019-01-01T00:00:00.000Z';
  const deletedAt = '2025-01-03T00:00:00.000Z';
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 1, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: deletedAt, deletedAt, createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Betroffenenrecht', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Freigegeben', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
}

describe('restore private healthcheck', () => {
  it('passes a clean private restore state but still grants no promotion', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    const reconciliation = clearReconciliation();
    const { manifest, result } = await evidence(db, reconciliation);

    const report = await assessRestorePrivateHealthcheck(db, reconciliation, manifest, result, roots);

    expect(report).toMatchObject({
      healthcheckVersion: 1,
      status: 'HEALTHY',
      healthcheckPassed: true,
      readyForPromotionReview: true,
      promotionAllowed: false,
      reconciliationStatus: 'CLEAR',
      databaseStatus: 'DATABASE_SATISFIED',
      artifactManifestVerified: true,
      artifactReplayVerified: true,
      blockers: [],
      transientExecutions: [],
    });
    expect(report.storage).toEqual([
      { kind: 'REPORT', databaseReferenceCount: 0, activeFileCount: 0, quarantineFileCount: 0, symlinkCount: 0, specialEntryCount: 0 },
      { kind: 'TENANT_EXPORT', databaseReferenceCount: 0, activeFileCount: 0, quarantineFileCount: 0, symlinkCount: 0, specialEntryCount: 0 },
      { kind: 'DATA_SUBJECT_DELIVERY', databaseReferenceCount: 0, activeFileCount: 0, quarantineFileCount: 0, symlinkCount: 0, specialEntryCount: 0 },
    ]);
  });

  it('blocks missing/orphaned active artifacts, quarantine content and symlinks without modifying them', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    const createdAt = '2020-01-01T00:00:00.000Z';
    await db.insert(schema.tenants).values({
      id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
      timezone: 'Europe/Berlin', locale: 'de', retentionYears: 5, createdAt, updatedAt: createdAt,
    });
    await db.insert(schema.users).values({
      id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
      createdAt, updatedAt: createdAt,
    });
    await db.insert(schema.tenantExportPackages).values({
      id: 'export-a', tenantId: 'tenant-a', tokenHash: `sha256:${'1'.repeat(64)}`,
      storageReference: '11111111-1111-1111-1111-111111111111.mde',
      packageSha256: `sha256:${'2'.repeat(64)}`, createdByUserId: 'admin-a',
      expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null, createdAt, updatedAt: createdAt,
    });
    const orphan = join(roots.reportRoot, 'tenant-a/test-a/de/orphan.pdf');
    const quarantined = join(
      roots.dataSubjectDeliveryRoot,
      '.anonymization-quarantine/execution-before-backup/33333333-3333-3333-3333-333333333333.mdse',
    );
    await put(orphan, 'orphan');
    await put(quarantined, 'quarantine');
    const outside = await mkdtemp(join(tmpdir(), 'restore-healthcheck-outside-'));
    await symlink(outside, join(roots.reportRoot, 'unsafe-link'));

    const reconciliation = clearReconciliation();
    const { manifest, result } = await evidence(db, reconciliation);
    const report = await assessRestorePrivateHealthcheck(db, reconciliation, manifest, result, roots);
    const codes = report.blockers.map((item) => item.code);

    expect(report.status).toBe('BLOCKED');
    expect(report.promotionAllowed).toBe(false);
    expect(codes).toContain('ACTIVE_ARTIFACT_MISSING');
    expect(codes).toContain('ACTIVE_ARTIFACT_ORPHANED');
    expect(codes).toContain('ANONYMIZATION_QUARANTINE_NOT_EMPTY');
    expect(codes).toContain('STORAGE_SYMLINK_PRESENT');
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(orphan, 'utf8'))).toBe('orphan');
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(quarantined, 'utf8'))).toBe('quarantine');
  });

  it('blocks an in-flight anonymization execution at the backup state', async () => {
    const db = await createTestDatabase();
    const roots = await storageRoots();
    await seedReadyAthlete(db);
    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', adminActor, disabledCapabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, adminActor, disabledCapabilities,
      '2026-08-05T13:10:00.000Z',
    );
    const reconciliation = clearReconciliation();
    const { manifest, result } = await evidence(db, reconciliation);

    const report = await assessRestorePrivateHealthcheck(db, reconciliation, manifest, result, roots);

    expect(report.status).toBe('BLOCKED');
    expect(report.transientExecutions).toEqual([{
      executionId: execution.id,
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      status: 'PREPARING',
    }]);
    expect(report.blockers).toContainEqual({
      code: 'ANONYMIZATION_EXECUTION_TRANSIENT',
      kind: null,
      reference: null,
      executionId: execution.id,
      executionStatus: 'PREPARING',
    });
  });
});
