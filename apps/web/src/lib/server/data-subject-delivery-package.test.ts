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
import { FileSystemReportArtifactStorage } from '../report-artifact-storage';
import { prepareAthleteDataSubjectDeliveryPackage } from './data-subject-delivery-package';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-data-subject-package-${crypto.randomUUID()}.db`;
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

async function setup(actualReportBytes: Uint8Array, expectedHash: string, storeReport = true) {
  const db = await createTestDatabase();
  await seed(db, expectedHash);
  const root = await mkdtemp(join(tmpdir(), 'masters-data-subject-package-'));
  roots.push(root);
  const storage = new FileSystemReportArtifactStorage(root);
  if (storeReport) await storage.put(reportReference, actualReportBytes);
  const approval = await approveAthleteDataSubjectDeliveryReview(
    db, 'tenant-a', 'athlete-a', actor, [], '2026-08-05T20:00:00.000Z',
  );
  return { db, storage, approval };
}

describe('data subject delivery package preparation', () => {
  it('binds reviewed JSON and the exact verified report bytes into a deterministic manifest', async () => {
    const reportBytes = new TextEncoder().encode('%PDF-1.7\nverified report\n%%EOF');
    const expectedHash = await sha256(reportBytes);
    const { db, storage, approval } = await setup(reportBytes, expectedHash);
    const auditBefore = await db.select().from(schema.auditEvents);

    const prepared = await prepareAthleteDataSubjectDeliveryPackage(
      db, storage, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T20:05:00.000Z',
    );
    const repeated = await prepareAthleteDataSubjectDeliveryPackage(
      db, storage, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T20:06:00.000Z',
    );

    expect(prepared.manifest.manifestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(repeated.manifest.manifestFingerprint).toBe(prepared.manifest.manifestFingerprint);
    expect(prepared.manifest.files).toHaveLength(2);
    expect(prepared.manifest.files[0]).toMatchObject({
      kind: 'DATA_JSON', path: 'data.json', mediaType: 'application/json',
    });
    expect(prepared.manifest.files[1]).toEqual({
      kind: 'REPORT_PDF',
      path: 'reports/0001.pdf',
      mediaType: 'application/pdf',
      reportVersionId: 'report-a',
      sha256: expectedHash,
      byteLength: reportBytes.byteLength,
    });

    const preparedReport = prepared.files.find((file) => file.path === 'reports/0001.pdf');
    expect(preparedReport).toBeDefined();
    expect(Array.from(preparedReport!.bytes)).toEqual(Array.from(reportBytes));
    const manifestDocument = JSON.parse(new TextDecoder().decode(prepared.manifestJson));
    expect(manifestDocument).toEqual(prepared.manifest);

    const dataFile = prepared.files.find((file) => file.path === 'data.json');
    expect(dataFile).toBeDefined();
    const dataText = new TextDecoder().decode(dataFile!.bytes);
    expect(dataText).toContain(approval.id);
    expect(dataText).not.toContain('admin-a');
    expect(await db.select().from(schema.auditEvents)).toEqual(auditBefore);
  });

  it('fails closed when report bytes do not match the immutable report content hash', async () => {
    const expectedBytes = new TextEncoder().encode('%PDF-1.7\nexpected\n%%EOF');
    const actualBytes = new TextEncoder().encode('%PDF-1.7\ntampered\n%%EOF');
    const { db, storage, approval } = await setup(actualBytes, await sha256(expectedBytes));

    await expect(prepareAthleteDataSubjectDeliveryPackage(
      db, storage, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T20:05:00.000Z',
    )).rejects.toThrow(/integrity check failed/i);
  });

  it('fails closed when a referenced report artifact is missing', async () => {
    const reportBytes = new TextEncoder().encode('%PDF-1.7\nmissing\n%%EOF');
    const { db, storage, approval } = await setup(reportBytes, await sha256(reportBytes), false);

    await expect(prepareAthleteDataSubjectDeliveryPackage(
      db, storage, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T20:05:00.000Z',
    )).rejects.toThrow();
  });
});
