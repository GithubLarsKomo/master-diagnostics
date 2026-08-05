import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { getAthleteDataSubjectExportSource } from '../src/services/data-subject-export';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-data-subject-export-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const createdAt = '2020-01-01T00:00:00.000Z';

async function seed(db: Database) {
  await db.insert(schema.tenants).values([
    {
      id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
      timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10, createdAt, updatedAt: createdAt,
    },
    {
      id: 'tenant-b', slug: 'tenant-b', name: 'Tenant B', deploymentMode: 'CLUB',
      timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10, createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.users).values({
    id: 'coach-a', email: 'coach@example.test', displayName: 'Coach', preferredLocale: 'de',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athletes).values([
    {
      id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
      birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
      currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
      trainingStatus: 'TRAINED', consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
    },
    {
      id: 'athlete-b', tenantId: 'tenant-b', linkedUserId: null, firstName: 'Bruno', lastName: 'Fremd',
      birthDate: '1975-01-01', referenceCategory: 'MASTERS', heightCm: 180,
      currentWeightKgX100: 8000, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
      trainingStatus: 'TRAINED', consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.athleteSnapshots).values([
    {
      id: 'snapshot-a', tenantId: 'tenant-a', athleteId: 'athlete-a',
      snapshotJson: '{"firstName":"Petra","lastName":"Muster"}', version: 1,
      createdAt, updatedAt: createdAt,
    },
    {
      id: 'snapshot-b', tenantId: 'tenant-b', athleteId: 'athlete-b',
      snapshotJson: '{"firstName":"Bruno","lastName":"Fremd"}', version: 1,
      createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.athleteGuardians).values([
    {
      id: 'guardian-a', tenantId: 'tenant-a', athleteId: 'athlete-a', fullName: 'Erika Muster',
      relationship: 'parent', email: 'erika@example.test', phone: '+491111111',
      authorityConfirmedAt: createdAt, validUntil: null, revokedAt: null, createdAt, updatedAt: createdAt,
    },
    {
      id: 'guardian-b', tenantId: 'tenant-b', athleteId: 'athlete-b', fullName: 'Fremde Person',
      relationship: 'parent', email: 'fremd@example.test', phone: '+492222222',
      authorityConfirmedAt: createdAt, validUntil: null, revokedAt: null, createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.tests).values([
    {
      id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
      conductingTrainerUserId: 'coach-a', startedAt: '2020-01-01T10:00:00.000Z',
      endedAt: '2020-01-01T11:00:00.000Z', releasedAt: '2020-01-01T12:00:00.000Z', currentVersion: 1,
      createdAt, updatedAt: createdAt,
    },
    {
      id: 'test-b', tenantId: 'tenant-b', athleteId: 'athlete-b', deviceType: 'ROWERG', status: 'RELEASED',
      conductingTrainerUserId: 'coach-a', startedAt: '2020-01-02T10:00:00.000Z',
      endedAt: '2020-01-02T11:00:00.000Z', releasedAt: '2020-01-02T12:00:00.000Z', currentVersion: 1,
      createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.interpretations).values([
    {
      id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
      lt1Json: '{}', lt2Json: '{}', rationale: 'Petra result', status: 'RELEASED',
      releasedAt: '2020-01-01T12:00:00.000Z', releasedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
    },
    {
      id: 'interpretation-b', tenantId: 'tenant-b', testId: 'test-b', versionNumber: 1,
      lt1Json: '{}', lt2Json: '{}', rationale: 'Bruno result', status: 'RELEASED',
      releasedAt: '2020-01-02T12:00:00.000Z', releasedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.reportVersions).values([
    {
      id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a',
      versionNumber: 1, locale: 'de', contentHash: `sha256:${'a'.repeat(64)}`,
      storageReference: 'tenant-a/test-a/de/report-a.pdf', createdAt, updatedAt: createdAt,
    },
    {
      id: 'report-b', tenantId: 'tenant-b', testId: 'test-b', interpretationId: 'interpretation-b',
      versionNumber: 1, locale: 'de', contentHash: `sha256:${'b'.repeat(64)}`,
      storageReference: 'tenant-b/test-b/de/report-b.pdf', createdAt, updatedAt: createdAt,
    },
  ]);
}

describe('athlete data subject export source', () => {
  it('returns only subject-owned fachliche rows and report references without mutating data', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const auditBefore = await db.select().from(schema.auditEvents);

    const source = await getAthleteDataSubjectExportSource(db, 'tenant-a', 'athlete-a');

    expect(source).not.toBeNull();
    expect(source?.data.athletes).toHaveLength(1);
    expect(source?.data.athlete_snapshots).toHaveLength(1);
    expect(source?.data.athlete_guardians).toHaveLength(1);
    expect(source?.data.tests).toHaveLength(1);
    expect(source?.data.interpretations).toHaveLength(1);
    expect(source?.data.report_versions).toHaveLength(1);
    expect(source?.reportArtifacts).toEqual([{
      reportVersionId: 'report-a',
      storageReference: 'tenant-a/test-a/de/report-a.pdf',
      mediaType: 'application/pdf',
    }]);

    const serialized = JSON.stringify(source);
    expect(serialized).toContain('Petra');
    expect(serialized).toContain('Erika Muster');
    expect(serialized).not.toContain('Bruno');
    expect(serialized).not.toContain('Fremde Person');
    expect(serialized).not.toContain('report-b');
    expect(serialized).not.toContain('tenant_export_packages');

    expect(await db.select().from(schema.auditEvents)).toEqual(auditBefore);
    expect(await db.select().from(schema.athletes)).toHaveLength(2);
    expect(await db.select().from(schema.tests)).toHaveLength(2);
  });

  it('returns null when the athlete does not belong to the requested tenant', async () => {
    const db = await createTestDatabase();
    await seed(db);

    expect(await getAthleteDataSubjectExportSource(db, 'tenant-b', 'athlete-a')).toBeNull();
  });
});
