import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { getAthleteRetentionAssessment } from '../src/services/retention';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-retention-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function seedTenant(
  db: Database,
  id: string,
  retentionYears: number,
): Promise<void> {
  const timestamp = '2020-01-01T00:00:00.000Z';
  await db.insert(schema.tenants).values({
    id,
    slug: id,
    name: id,
    deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin',
    locale: 'de',
    retentionYears,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function seedUser(db: Database, id: string): Promise<void> {
  const timestamp = '2020-01-01T00:00:00.000Z';
  await db.insert(schema.users).values({
    id,
    email: `${id}@example.test`,
    displayName: id,
    preferredLocale: 'de',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function seedAthlete(
  db: Database,
  tenantId: string,
  id: string,
  options: { linkedUserId?: string | null; createdAt?: string; deletedAt?: string | null } = {},
): Promise<void> {
  const createdAt = options.createdAt ?? '2024-01-01T00:00:00.000Z';
  await db.insert(schema.athletes).values({
    id,
    tenantId,
    linkedUserId: options.linkedUserId ?? null,
    firstName: 'Petra',
    lastName: 'Muster',
    birthDate: '1980-01-01',
    referenceCategory: 'MASTERS',
    heightCm: 175,
    currentWeightKgX100: 6900,
    primarySport: 'ROWING',
    primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED',
    deletedAt: options.deletedAt ?? null,
    createdAt,
    updatedAt: createdAt,
  });
}

async function seedTest(
  db: Database,
  input: {
    id: string;
    tenantId: string;
    athleteId: string;
    status: 'PLANNED' | 'IN_PROGRESS' | 'DATA_REVIEW' | 'INTERPRETED' | 'RELEASED' | 'ARCHIVED';
    createdAt: string;
    startedAt?: string | null;
    endedAt?: string | null;
  },
): Promise<void> {
  await db.insert(schema.tests).values({
    id: input.id,
    tenantId: input.tenantId,
    athleteId: input.athleteId,
    deviceType: 'ROWERG',
    status: input.status,
    conductingTrainerUserId: 'trainer-a',
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

describe('tenant-scoped athlete retention assessment', () => {
  it('uses the latest performed test and ignores a newer never-started plan', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a', 2);
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2020-01-01T00:00:00.000Z',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    await seedTest(db, {
      id: 'test-released',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      status: 'RELEASED',
      createdAt: '2025-02-01T09:00:00.000Z',
      startedAt: '2025-02-01T10:00:00.000Z',
      endedAt: '2025-02-01T11:00:00.000Z',
    });
    await seedTest(db, {
      id: 'test-planned',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      status: 'PLANNED',
      createdAt: '2026-12-01T09:00:00.000Z',
    });

    expect(await getAthleteRetentionAssessment(
      db,
      'tenant-a',
      'athlete-a',
      '2027-02-01T11:00:00.000Z',
    )).toEqual({
      basis: 'LAST_TEST',
      reason: 'RETENTION_EXPIRED',
      tenantRetentionYears: 2,
      referenceAt: '2025-02-01T11:00:00.000Z',
      retainUntil: '2027-02-01T11:00:00.000Z',
      eligibleForIrreversibleAction: true,
    });
  });

  it('applies the twelve-month managed-profile rule when no test was performed', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a', 10);
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2026-05-01T08:00:00.000Z',
    });

    expect(await getAthleteRetentionAssessment(
      db,
      'tenant-a',
      'athlete-a',
      '2027-04-30T08:00:00.000Z',
    )).toMatchObject({
      basis: 'MANAGED_PROFILE_NO_TEST',
      reason: 'RETENTION_ACTIVE',
      retainUntil: '2027-05-01T08:00:00.000Z',
      eligibleForIrreversibleAction: false,
    });
  });

  it('fails closed for linked profiles without tests and stays tenant scoped', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a', 3);
    await seedTenant(db, 'tenant-b', 1);
    await seedUser(db, 'user-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      linkedUserId: 'user-a',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    expect(await getAthleteRetentionAssessment(
      db,
      'tenant-a',
      'athlete-a',
      '2030-01-01T00:00:00.000Z',
    )).toMatchObject({
      basis: 'MANUAL_REVIEW',
      reason: 'MANUAL_REVIEW_REQUIRED',
      eligibleForIrreversibleAction: false,
    });
    await expect(getAthleteRetentionAssessment(
      db,
      'tenant-b',
      'athlete-a',
    )).rejects.toThrow('Athlete not found');
  });
});
