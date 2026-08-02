import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { appendReportVersion, getReportVersion, listReportVersions } from '../src/services/report-versions';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-report-versions-${crypto.randomUUID()}.db` });
  await client.batch([
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE interpretations (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, version_number INTEGER NOT NULL, lt1_json TEXT NOT NULL, lt2_json TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, released_at TEXT, released_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE report_versions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, interpretation_id TEXT NOT NULL, version_number INTEGER NOT NULL, locale TEXT NOT NULL, content_hash TEXT NOT NULL, storage_reference TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX report_version_test_locale_version_uq ON report_versions (tenant_id, test_id, locale, version_number)`,
    `CREATE TRIGGER report_versions_immutable_update BEFORE UPDATE ON report_versions BEGIN SELECT RAISE(ABORT, 'report versions are immutable'); END`,
    `CREATE TRIGGER report_versions_immutable_delete BEFORE DELETE ON report_versions BEGIN SELECT RAISE(ABORT, 'report versions are immutable'); END`,
  ]);
  return drizzle(client, { schema }) as Database;
}

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;

describe('immutable report versions', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    const now = '2026-08-02T10:00:00.000Z';
    await db.insert(schema.tests).values({
      id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED', conductingTrainerUserId: 'trainer-a', currentVersion: 1, releasedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.interpretations).values([
      { id: 'interp-released', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1, lt1Json: '{}', lt2Json: '{}', status: 'RELEASED', releasedAt: now, releasedByUserId: 'trainer-a', createdAt: now, updatedAt: now },
      { id: 'interp-draft', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 2, lt1Json: '{}', lt2Json: '{}', status: 'DRAFT', createdAt: now, updatedAt: now },
    ]);
  });

  it('appends independent immutable version sequences per locale', async () => {
    const de1 = await appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: hashA, storageReference: 'reports/test-a/de/v1.pdf' });
    const de2 = await appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: hashB, storageReference: 'reports/test-a/de/v2.pdf' });
    const en1 = await appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'en', contentHash: hashA, storageReference: 'reports/test-a/en/v1.pdf' });

    expect([de1.versionNumber, de2.versionNumber, en1.versionNumber]).toEqual([1, 2, 1]);
    expect(Object.isFrozen(de1)).toBe(true);
    expect((await listReportVersions(db, 'tenant-a', 'test-a', 'de')).map((item) => item.versionNumber)).toEqual([2, 1]);
  });

  it('rejects a stale expected version before creating another immutable row', async () => {
    await appendReportVersion(db, 'tenant-a', 'test-a', {
      interpretationId: 'interp-released', locale: 'de', contentHash: hashA,
      storageReference: 'reports/test-a/de/v1.pdf', expectedVersionNumber: 1,
    });
    await expect(appendReportVersion(db, 'tenant-a', 'test-a', {
      interpretationId: 'interp-released', locale: 'de', contentHash: hashB,
      storageReference: 'reports/test-a/de/stale.pdf', expectedVersionNumber: 1,
    })).rejects.toThrow('Report version changed during generation');
    expect(await listReportVersions(db, 'tenant-a', 'test-a', 'de')).toHaveLength(1);
  });

  it('reads a report version only inside its tenant and test boundary', async () => {
    const created = await appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: hashA, storageReference: 'reports/test-a/de/v1.pdf' });
    expect((await getReportVersion(db, 'tenant-a', 'test-a', created.id))?.id).toBe(created.id);
    expect(await getReportVersion(db, 'tenant-b', 'test-a', created.id)).toBeNull();
    expect(await getReportVersion(db, 'tenant-a', 'test-b', created.id)).toBeNull();
    expect(await getReportVersion(db, 'tenant-a', 'test-a', crypto.randomUUID())).toBeNull();
  });

  it('enforces one version number per test and locale at database level', async () => {
    const created = await appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: hashA, storageReference: 'reports/test-a/de/v1.pdf' });
    await expect(db.insert(schema.reportVersions).values({
      id: crypto.randomUUID(), tenantId: created.tenantId, testId: created.testId, interpretationId: created.interpretationId, versionNumber: created.versionNumber, locale: created.locale, contentHash: hashB, storageReference: 'reports/test-a/de/duplicate.pdf', createdAt: '2026-08-02T10:01:00.000Z', updatedAt: '2026-08-02T10:01:00.000Z',
    })).rejects.toThrow();
  });

  it('rejects direct updates and deletes at database level', async () => {
    const created = await appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: hashA, storageReference: 'reports/test-a/de/v1.pdf' });
    await expect(db.update(schema.reportVersions).set({ storageReference: 'reports/test-a/de/changed.pdf' }).where(eq(schema.reportVersions.id, created.id))).rejects.toThrow();
    const [afterUpdate] = await db.select().from(schema.reportVersions).where(eq(schema.reportVersions.id, created.id)).limit(1);
    expect(afterUpdate?.storageReference).toBe(created.storageReference);
    await expect(db.delete(schema.reportVersions).where(eq(schema.reportVersions.id, created.id))).rejects.toThrow();
    const [afterDelete] = await db.select().from(schema.reportVersions).where(eq(schema.reportVersions.id, created.id)).limit(1);
    expect(afterDelete?.id).toBe(created.id);
    expect(afterDelete?.contentHash).toBe(created.contentHash);
  });

  it('rejects draft interpretations, foreign tenants and invalid hashes', async () => {
    await expect(appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-draft', locale: 'de', contentHash: hashA, storageReference: 'draft.pdf' })).rejects.toThrow('Released interpretation');
    await expect(appendReportVersion(db, 'tenant-b', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: hashA, storageReference: 'foreign.pdf' })).rejects.toThrow('Released interpretation');
    await expect(appendReportVersion(db, 'tenant-a', 'test-a', { interpretationId: 'interp-released', locale: 'de', contentHash: 'bad', storageReference: 'bad.pdf' })).rejects.toThrow('hash is invalid');
  });
});
