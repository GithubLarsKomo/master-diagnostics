import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
import {
  createDataSubjectDeliveryPackage,
  decryptDataSubjectDeliveryArchive,
  hashDataSubjectDeliveryToken,
} from './data-subject-delivery-package-writer';

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
  const databasePath = `/tmp/masters-data-subject-package-writer-${crypto.randomUUID()}.db`;
  const db = createDatabaseFromConfig({ url: `file:${databasePath}` });
  await migrateDatabase(db, '../../packages/db/migrations');
  return db;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const createdAt = '2020-01-01T00:00:00.000Z';
const reportReference = 'tenant-a/test-a/de/report-a.pdf';
const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};

async function seed(db: Database, contentHash: string) {
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin-a@example.test', displayName: 'Admin A', preferredLocale: 'de',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.tests).values({
    id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
    conductingTrainerUserId: 'admin-a', startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: '2020-01-01T11:00:00.000Z', releasedAt: '2020-01-01T12:00:00.000Z', currentVersion: 1,
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.interpretations).values({
    id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
    lt1Json: '{}', lt2Json: '{}', rationale: null, status: 'RELEASED',
    releasedAt: '2020-01-01T12:00:00.000Z', releasedByUserId: 'admin-a', createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.reportVersions).values({
    id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a',
    versionNumber: 1, locale: 'de', contentHash, storageReference: reportReference,
    createdAt, updatedAt: createdAt,
  });
}

function parseTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = new TextDecoder().decode(header.slice(0, 100)).replace(/\0.*$/, '');
    const sizeText = new TextDecoder().decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!name || !Number.isFinite(size)) throw new Error('Invalid TAR test fixture');
    const start = offset + 512;
    files.set(name, bytes.slice(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function setup() {
  const db = await createTestDatabase();
  const reportBytes = new TextEncoder().encode('%PDF-1.7\nsubject report\n%%EOF');
  await seed(db, await sha256(reportBytes));
  const reportStorage = new FileSystemReportArtifactStorage(await tempRoot('masters-subject-writer-reports-'));
  await reportStorage.put(reportReference, reportBytes);
  const packageRoot = await tempRoot('masters-subject-writer-packages-');
  const packageStorage = new FileSystemDataSubjectDeliveryPackageStorage(packageRoot);
  const approval = await approveAthleteDataSubjectDeliveryReview(
    db, 'tenant-a', 'athlete-a', actor, [], '2026-08-05T21:00:00.000Z',
  );
  return { db, reportBytes, reportStorage, packageRoot, packageStorage, approval };
}

describe('data subject delivery package writer', () => {
  it('persists only an encrypted package, stores only the token hash and audits creation without subject PII', async () => {
    const { db, reportBytes, reportStorage, packageStorage, approval } = await setup();
    const created = await createDataSubjectDeliveryPackage({
      db,
      reportStorage,
      packageStorage,
      now: () => '2026-08-05T21:05:00.000Z',
    }, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id, actor,
    });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.record.tokenHash).toBe(await hashDataSubjectDeliveryToken(created.token));
    expect(created.record.tokenHash).not.toContain(created.token);
    expect(created.record.expiresAt).toBe('2026-08-06T21:05:00.000Z');
    expect(created.record.storageReference).toBe(`${created.record.id}.mdse`);

    const encrypted = await packageStorage.get(created.record.storageReference);
    expect(await sha256(encrypted)).toBe(created.record.packageSha256);
    expect(new TextDecoder().decode(encrypted)).not.toContain('Petra');
    expect(new TextDecoder().decode(encrypted)).not.toContain('subject report');

    const archive = await decryptDataSubjectDeliveryArchive(
      encrypted,
      created.token,
      created.record.id,
      created.record.manifestFingerprint,
    );
    const files = parseTar(archive);
    expect([...files.keys()]).toEqual(['manifest.json', 'data.json', 'reports/0001.pdf']);
    expect(Array.from(files.get('reports/0001.pdf')!)).toEqual(Array.from(reportBytes));
    expect(new TextDecoder().decode(files.get('data.json')!)).toContain('Petra');

    await expect(decryptDataSubjectDeliveryArchive(
      encrypted,
      'wrong-token',
      created.record.id,
      created.record.manifestFingerprint,
    )).rejects.toThrow(/authentication failed/i);

    const records = await db.select().from(schema.athleteDataSubjectDeliveryPackages);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain(created.token);
    const creationAudits = (await db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_created',
    );
    expect(creationAudits).toHaveLength(1);
    const serializedAudit = JSON.stringify(creationAudits[0]);
    expect(serializedAudit).not.toContain('Petra');
    expect(serializedAudit).not.toContain(created.token);
    expect(serializedAudit).toContain(created.record.manifestFingerprint);
  });

  it('removes the encrypted artifact if metadata/audit persistence fails', async () => {
    const { db, reportStorage, packageRoot, packageStorage, approval } = await setup();
    await db.$client.execute(`
      CREATE TRIGGER test_reject_subject_package_insert
      BEFORE INSERT ON athlete_data_subject_delivery_packages
      BEGIN
        SELECT RAISE(ABORT, 'simulated package metadata failure');
      END;
    `);

    await expect(createDataSubjectDeliveryPackage({
      db,
      reportStorage,
      packageStorage,
      now: () => '2026-08-05T21:05:00.000Z',
    }, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id, actor,
    })).rejects.toThrow();

    expect(await db.select().from(schema.athleteDataSubjectDeliveryPackages)).toEqual([]);
    expect(await readdir(packageRoot)).toEqual([]);
    expect((await db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_export_created',
    )).toEqual([]);
  });

  it('rejects non-admin creation and package lifetimes beyond seven days before writing storage', async () => {
    const { db, reportStorage, packageRoot, packageStorage, approval } = await setup();

    await expect(createDataSubjectDeliveryPackage({
      db, reportStorage, packageStorage, now: () => '2026-08-05T21:05:00.000Z',
    }, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id,
      actor: { ...actor, role: 'TRAINER' },
    })).rejects.toThrow(/tenant admin/i);

    await expect(createDataSubjectDeliveryPackage({
      db, reportStorage, packageStorage, now: () => '2026-08-05T21:05:00.000Z',
    }, {
      tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: approval.id, actor,
      ttlMs: 8 * 24 * 60 * 60 * 1000,
    })).rejects.toThrow(/at most seven days/i);

    expect(await readdir(packageRoot)).toEqual([]);
    expect(await db.select().from(schema.athleteDataSubjectDeliveryPackages)).toEqual([]);
  });
});
