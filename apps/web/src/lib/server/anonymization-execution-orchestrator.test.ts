import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approveAthleteAnonymization,
  createDatabaseFromConfig,
  getAthleteAnonymizationExecutionByApproval,
  migrateDatabase,
  type Database,
  type GlobalPrivacyCapabilities,
} from '@masters/db';
import * as schema from '@masters/db';
import {
  FileSystemReportArtifactStorage,
  type QuarantinableReportArtifactStorage,
  type StagedReportArtifact,
} from '@/lib/report-artifact-storage';
import {
  FileSystemTenantExportPackageStorage,
  type QuarantinableTenantExportPackageStorage,
  type StagedTenantExportPackage,
} from '@/lib/tenant-export-package-storage';
import {
  executeAthleteAnonymization,
  recoverCommittedAthleteAnonymization,
  type AthleteAnonymizationOrchestratorDependencies,
} from './anonymization-execution-orchestrator';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-anonymization-orchestrator-${crypto.randomUUID()}.db`;
  const db = createDatabaseFromConfig({ url: `file:${databasePath}` });
  await migrateDatabase(db, '../../packages/db/migrations');
  return db;
}

const createdAt = '2019-01-01T00:00:00.000Z';
const deletedAt = '2025-01-03T00:00:00.000Z';
const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};
const capabilities: GlobalPrivacyCapabilities = {
  backup: { state: 'DISABLED' }, notifications: { state: 'DISABLED' },
};
const reportReference = 'tenant-a/test-a/de/report-a.pdf';
const exportReference = '01234567-89ab-cdef-0123-456789abcdef.mde';

async function seed(db: Database) {
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
  await db.insert(schema.tests).values({
    id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
    conductingTrainerUserId: 'trainer-a', startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: '2020-01-01T11:00:00.000Z', releasedAt: '2020-01-01T11:00:00.000Z', currentVersion: 1,
    createdAt: '2020-01-01T09:00:00.000Z', updatedAt: '2020-01-01T11:00:00.000Z',
  });
  await db.insert(schema.interpretations).values({
    id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    lt1Json: '{}', lt2Json: '{}', rationale: null, status: 'RELEASED',
    releasedAt: '2020-01-01T12:00:00.000Z', releasedByUserId: 'admin-a',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.reportVersions).values({
    id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a',
    versionNumber: 1, locale: 'de', contentHash: `sha256:${'a'.repeat(64)}`,
    storageReference: reportReference, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tenantExportPackages).values({
    id: 'export-a', tenantId: 'tenant-a', tokenHash: `sha256:${'b'.repeat(64)}`,
    storageReference: exportReference, packageSha256: `sha256:${'c'.repeat(64)}`,
    createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Petra requested deletion', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Approved for Petra', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
}

async function setup() {
  const db = await createTestDatabase();
  await seed(db);
  const reportStorage = new FileSystemReportArtifactStorage(await tempRoot('masters-orchestrator-reports-'));
  const exportStorage = new FileSystemTenantExportPackageStorage(await tempRoot('masters-orchestrator-exports-'));
  await reportStorage.put(reportReference, new TextEncoder().encode('report-pdf'));
  await exportStorage.put(exportReference, new TextEncoder().encode('encrypted-export'));
  const approval = await approveAthleteAnonymization(
    db, 'tenant-a', 'athlete-a', actor, capabilities, '2026-08-05T13:00:00.000Z',
  );
  const deps: AthleteAnonymizationOrchestratorDependencies = {
    db, reportStorage, exportStorage, now: () => '2026-08-05T13:05:00.000Z',
  };
  return { db, reportStorage, exportStorage, approval, deps };
}

class MutatingExportStorage implements QuarantinableTenantExportPackageStorage {
  private mutated = false;
  constructor(
    private readonly base: QuarantinableTenantExportPackageStorage,
    private readonly afterStage: () => Promise<void>,
  ) {}
  put(reference: string, bytes: Uint8Array) { return this.base.put(reference, bytes); }
  get(reference: string) { return this.base.get(reference); }
  remove(reference: string) { return this.base.remove(reference); }
  async stageForDeletion(executionId: string, reference: string): Promise<Readonly<StagedTenantExportPackage>> {
    const handle = await this.base.stageForDeletion(executionId, reference);
    if (!this.mutated) {
      this.mutated = true;
      await this.afterStage();
    }
    return handle;
  }
  restoreStaged(handle: Readonly<StagedTenantExportPackage>) { return this.base.restoreStaged(handle); }
  purgeStaged(handle: Readonly<StagedTenantExportPackage>) { return this.base.purgeStaged(handle); }
}

class FailOnceReportPurgeStorage implements QuarantinableReportArtifactStorage {
  private failed = false;
  constructor(private readonly base: QuarantinableReportArtifactStorage) {}
  put(reference: string, bytes: Uint8Array) { return this.base.put(reference, bytes); }
  get(reference: string) { return this.base.get(reference); }
  remove(reference: string) { return this.base.remove(reference); }
  stageForDeletion(executionId: string, reference: string) { return this.base.stageForDeletion(executionId, reference); }
  restoreStaged(handle: Readonly<StagedReportArtifact>) { return this.base.restoreStaged(handle); }
  async purgeStaged(handle: Readonly<StagedReportArtifact>): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('simulated purge failure');
    }
    await this.base.purgeStaged(handle);
  }
}

describe('athlete anonymization end-to-end orchestrator', () => {
  it('stages artifacts, commits the DB, purges quarantine and completes exactly once', async () => {
    const { db, reportStorage, exportStorage, approval, deps } = await setup();

    const completed = await executeAthleteAnonymization(deps, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id,
      actor, globalCapabilities: capabilities,
    });
    expect(completed.status).toBe('COMPLETED');
    await expect(reportStorage.get(reportReference)).rejects.toThrow();
    await expect(exportStorage.get(exportReference)).rejects.toThrow();
    expect(await db.select().from(schema.reportVersions)).toEqual([]);
    expect(await db.select().from(schema.tenantExportPackages)).toEqual([]);
    expect(await db.select().from(schema.tests)).toEqual([]);
    const [athlete] = await db.select().from(schema.athletes);
    expect(athlete).toMatchObject({
      firstName: '[ANONYMIZED]', lastName: '[ANONYMIZED]', birthDate: '0001-01-01',
      heightCm: 0, currentWeightKgX100: 0,
    });

    const again = await executeAthleteAnonymization(deps, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id,
      actor, globalCapabilities: capabilities,
    });
    expect(again.id).toBe(completed.id);
    expect(again.status).toBe('COMPLETED');

    const actions = (await db.select().from(schema.auditEvents)).map((row) => row.action);
    expect(actions.filter((action) => action === 'athlete.anonymization_artifacts_staged')).toHaveLength(1);
    expect(actions.filter((action) => action === 'athlete.anonymization_db_committed')).toHaveLength(1);
    expect(actions.filter((action) => action === 'athlete.anonymization_completed')).toHaveLength(1);
  });

  it('restores staged artifacts and aborts when DB scope drifts after staging', async () => {
    const { db, reportStorage, exportStorage, approval, deps } = await setup();
    const mutatingExportStorage = new MutatingExportStorage(exportStorage, async () => {
      await db.insert(schema.tenantExportPackages).values({
        id: 'export-late', tenantId: 'tenant-a', tokenHash: `sha256:${'d'.repeat(64)}`,
        storageReference: 'fedcba98-7654-3210-fedc-ba9876543210.mde', packageSha256: `sha256:${'e'.repeat(64)}`,
        createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
        createdAt: '2026-08-05T13:05:00.000Z', updatedAt: '2026-08-05T13:05:00.000Z',
      });
    });

    await expect(executeAthleteAnonymization({ ...deps, exportStorage: mutatingExportStorage }, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id,
      actor, globalCapabilities: capabilities,
    })).rejects.toThrow();

    expect(new TextDecoder().decode(await reportStorage.get(reportReference))).toBe('report-pdf');
    expect(new TextDecoder().decode(await exportStorage.get(exportReference))).toBe('encrypted-export');
    const execution = await getAthleteAnonymizationExecutionByApproval(
      db, 'tenant-a', 'athlete-a', approval.id,
    );
    expect(execution?.status).toBe('ABORTED');
    const [athlete] = await db.select().from(schema.athletes);
    expect(athlete?.firstName).toBe('Petra');
    expect(await db.select().from(schema.tests)).toHaveLength(1);
  });

  it('leaves DB_COMMITTED on purge failure and recovers without replaying approval or DB mutation', async () => {
    const { db, reportStorage, exportStorage, approval, deps } = await setup();
    const failOnce = new FailOnceReportPurgeStorage(reportStorage);
    const failingDeps = { ...deps, reportStorage: failOnce };

    await expect(executeAthleteAnonymization(failingDeps, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id,
      actor, globalCapabilities: capabilities,
    })).rejects.toThrow(/purge/i);

    const committed = await getAthleteAnonymizationExecutionByApproval(
      db, 'tenant-a', 'athlete-a', approval.id,
    );
    expect(committed?.status).toBe('DB_COMMITTED');
    expect(await db.select().from(schema.tests)).toEqual([]);
    const [athleteAfterCommit] = await db.select().from(schema.athletes);
    expect(athleteAfterCommit?.firstName).toBe('[ANONYMIZED]');

    const recovered = await recoverCommittedAthleteAnonymization(failingDeps, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', executionId: committed!.id, actor,
    });
    expect(recovered.status).toBe('COMPLETED');
    await expect(reportStorage.get(reportReference)).rejects.toThrow();
    await expect(exportStorage.get(exportReference)).rejects.toThrow();

    const actions = (await db.select().from(schema.auditEvents)).map((row) => row.action);
    expect(actions.filter((action) => action === 'athlete.anonymization_db_committed')).toHaveLength(1);
    expect(actions.filter((action) => action === 'athlete.anonymization_completed')).toHaveLength(1);
  });
});
