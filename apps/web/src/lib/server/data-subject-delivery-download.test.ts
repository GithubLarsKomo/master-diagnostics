import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approveAthleteDataSubjectDeliveryReview,
  createDatabaseFromConfig,
  migrateDatabase,
  type Database,
} from '@masters/db';
import * as schema from '@masters/db';
import { FileSystemDataSubjectDeliveryPackageStorage } from '../data-subject-delivery-package-storage';
import { FileSystemReportArtifactStorage } from '../report-artifact-storage';
import { createDataSubjectDeliveryPackage } from './data-subject-delivery-package-writer';
import { consumeDataSubjectDeliveryDownload } from './data-subject-delivery-download';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-data-subject-download-${crypto.randomUUID()}.db`;
  const db = createDatabaseFromConfig({ url: `file:${databasePath}` });
  await migrateDatabase(db, '../../packages/db/migrations');
  return db;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const baseCreatedAt = '2020-01-01T00:00:00.000Z';
const packageCreatedAt = '2026-08-05T21:05:00.000Z';
const reportReference = 'tenant-a/test-a/de/report-a.pdf';
const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};

async function seed(db: Database, contentHash: string) {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10,
    createdAt: baseCreatedAt, updatedAt: baseCreatedAt,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin-a@example.test', displayName: 'Admin A', preferredLocale: 'de',
    createdAt: baseCreatedAt, updatedAt: baseCreatedAt,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: null, deletedAt: null,
    createdAt: baseCreatedAt, updatedAt: baseCreatedAt,
  });
  await db.insert(schema.tests).values({
    id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
    conductingTrainerUserId: 'admin-a', startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: '2020-01-01T11:00:00.000Z', releasedAt: '2020-01-01T12:00:00.000Z', currentVersion: 1,
    createdAt: baseCreatedAt, updatedAt: baseCreatedAt,
  });
  await db.insert(schema.interpretations).values({
    id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    lt1Json: '{}', lt2Json: '{}', rationale: null, status: 'RELEASED',
    releasedAt: '2020-01-01T12:00:00.000Z', releasedByUserId: 'admin-a',
    createdAt: baseCreatedAt, updatedAt: baseCreatedAt,
  });
  await db.insert(schema.reportVersions).values({
    id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a',
    versionNumber: 1, locale: 'de', contentHash, storageReference: reportReference,
    createdAt: baseCreatedAt, updatedAt: baseCreatedAt,
  });
}

async function setup(ttlMs?: number) {
  const db = await createTestDatabase();
  const reportBytes = new TextEncoder().encode('%PDF-1.7\ndownload report\n%%EOF');
  await seed(db, await sha256(reportBytes));
  const reportStorage = new FileSystemReportArtifactStorage(await tempRoot('masters-download-reports-'));
  await reportStorage.put(reportReference, reportBytes);
  const packageStorage = new FileSystemDataSubjectDeliveryPackageStorage(
    await tempRoot('masters-download-packages-'),
  );
  const approval = await approveAthleteDataSubjectDeliveryReview(
    db, 'tenant-a', 'athlete-a', actor, [], '2026-08-05T21:00:00.000Z',
  );
  const created = await createDataSubjectDeliveryPackage({
    db,
    reportStorage,
    packageStorage,
    now: () => packageCreatedAt,
  }, {
    tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id, actor, ttlMs,
  });
  return { db, packageStorage, created };
}

describe('one-time data subject delivery download', () => {
  it('returns the TAR exactly once and audits only the successful consumption', async () => {
    const { db, packageStorage, created } = await setup();
    const deps = { db, packageStorage, now: () => '2026-08-05T21:10:00.000Z' };

    const first = await consumeDataSubjectDeliveryDownload(deps, created.token);
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      packageId: created.record.id,
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      fileName: `masters-data-subject-export-${created.record.id}.tar`,
      mediaType: 'application/x-tar',
    });
    expect(new TextDecoder().decode(first!.bytes)).toContain('manifest.json');

    const second = await consumeDataSubjectDeliveryDownload(deps, created.token);
    expect(second).toBeNull();

    const [record] = await db.select().from(schema.athleteDataSubjectDeliveryPackages);
    expect(record?.downloadedAt).toBe('2026-08-05T21:10:00.000Z');
    expect(record?.updatedAt).toBe(record?.downloadedAt);
    const downloadAudits = (await db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_downloaded',
    );
    expect(downloadAudits).toHaveLength(1);
    const serializedAudit = JSON.stringify(downloadAudits[0]);
    expect(serializedAudit).not.toContain(created.token);
    expect(serializedAudit).not.toContain('Petra');
    expect(serializedAudit).toContain(created.record.manifestFingerprint);
  });

  it('allows only one winner when the same token is consumed concurrently', async () => {
    const { db, packageStorage, created } = await setup();
    const deps = { db, packageStorage, now: () => '2026-08-05T21:10:00.000Z' };

    const results = await Promise.all([
      consumeDataSubjectDeliveryDownload(deps, created.token),
      consumeDataSubjectDeliveryDownload(deps, created.token),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_downloaded',
    )).toHaveLength(1);
  });

  it('rejects wrong or expired tokens without consuming or auditing the package', async () => {
    const wrong = await setup();
    expect(await consumeDataSubjectDeliveryDownload({
      db: wrong.db,
      packageStorage: wrong.packageStorage,
      now: () => '2026-08-05T21:10:00.000Z',
    }, 'not-the-token')).toBeNull();
    let [record] = await wrong.db.select().from(schema.athleteDataSubjectDeliveryPackages);
    expect(record?.downloadedAt).toBeNull();
    expect((await wrong.db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_downloaded',
    )).toEqual([]);

    const expired = await setup(1_000);
    expect(await consumeDataSubjectDeliveryDownload({
      db: expired.db,
      packageStorage: expired.packageStorage,
      now: () => '2026-08-05T21:05:02.000Z',
    }, expired.created.token)).toBeNull();
    [record] = await expired.db.select().from(schema.athleteDataSubjectDeliveryPackages);
    expect(record?.downloadedAt).toBeNull();
    expect((await expired.db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_downloaded',
    )).toEqual([]);
  });

  it('does not consume a package whose encrypted artifact hash no longer matches metadata', async () => {
    const { db, packageStorage, created } = await setup();
    const encrypted = await packageStorage.get(created.record.storageReference);
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 0x01;
    await packageStorage.remove(created.record.storageReference);
    await packageStorage.put(created.record.storageReference, tampered);

    await expect(consumeDataSubjectDeliveryDownload({
      db,
      packageStorage,
      now: () => '2026-08-05T21:10:00.000Z',
    }, created.token)).rejects.toThrow(/integrity check failed/i);

    const [record] = await db.select().from(schema.athleteDataSubjectDeliveryPackages);
    expect(record?.downloadedAt).toBeNull();
    expect((await db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_downloaded',
    )).toEqual([]);
  });
});
