import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { buildRetentionJobPlan } from '../src/services/retention';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-retention-job-${crypto.randomUUID()}.db`;
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
  options: {
    linkedUserId?: string | null;
    createdAt?: string;
    consentBlockedAt?: string | null;
    deletedAt?: string | null;
  } = {},
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
    consentBlockedAt: options.consentBlockedAt ?? null,
    deletedAt: options.deletedAt ?? null,
    createdAt,
    updatedAt: createdAt,
  });
}

describe('read-only retention job plan', () => {
  it('scans tenants deterministically and never mutates athlete state', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-b', 4);
    await seedTenant(db, 'tenant-a', 2);
    await seedUser(db, 'user-manual');

    await seedAthlete(db, 'tenant-a', 'athlete-active', {
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    await seedAthlete(db, 'tenant-a', 'athlete-expired', {
      createdAt: '2020-01-01T00:00:00.000Z',
      consentBlockedAt: '2025-01-01T00:00:00.000Z',
      deletedAt: '2025-02-01T00:00:00.000Z',
    });
    await seedAthlete(db, 'tenant-b', 'athlete-manual', {
      linkedUserId: 'user-manual',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    const before = await db
      .select({
        id: schema.athletes.id,
        consentBlockedAt: schema.athletes.consentBlockedAt,
        deletedAt: schema.athletes.deletedAt,
        updatedAt: schema.athletes.updatedAt,
      })
      .from(schema.athletes)
      .orderBy(schema.athletes.id);

    const plan = await buildRetentionJobPlan(db, {
      assessedAt: '2027-07-31T00:00:00.000Z',
    });

    expect(plan).toMatchObject({
      mode: 'READ_ONLY',
      assessedAt: '2027-07-31T00:00:00.000Z',
      tenantCount: 2,
      candidateCount: 2,
      eligibleCount: 1,
      manualReviewCount: 1,
    });
    expect(plan.tenants.map((tenant) => ({
      tenantId: tenant.tenantId,
      candidateCount: tenant.candidateCount,
      eligibleCount: tenant.eligibleCount,
      manualReviewCount: tenant.manualReviewCount,
      athletes: tenant.candidates.map((candidate) => candidate.athleteId),
    }))).toEqual([
      {
        tenantId: 'tenant-a',
        candidateCount: 1,
        eligibleCount: 1,
        manualReviewCount: 0,
        athletes: ['athlete-expired'],
      },
      {
        tenantId: 'tenant-b',
        candidateCount: 1,
        eligibleCount: 0,
        manualReviewCount: 1,
        athletes: ['athlete-manual'],
      },
    ]);

    const after = await db
      .select({
        id: schema.athletes.id,
        consentBlockedAt: schema.athletes.consentBlockedAt,
        deletedAt: schema.athletes.deletedAt,
        updatedAt: schema.athletes.updatedAt,
      })
      .from(schema.athletes)
      .orderBy(schema.athletes.id);
    expect(after).toEqual(before);
  });

  it('supports a tenant-isolated targeted run and fails closed for unknown tenants', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a', 2);
    await seedTenant(db, 'tenant-b', 2);
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    await seedAthlete(db, 'tenant-b', 'athlete-b', {
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    const plan = await buildRetentionJobPlan(db, {
      tenantId: 'tenant-b',
      assessedAt: '2027-07-31T00:00:00.000Z',
    });
    expect(plan.tenantCount).toBe(1);
    expect(plan.tenants.map((tenant) => tenant.tenantId)).toEqual(['tenant-b']);
    expect(plan.tenants[0]?.candidates.map((candidate) => candidate.athleteId)).toEqual([
      'athlete-b',
    ]);

    await expect(buildRetentionJobPlan(db, {
      tenantId: 'tenant-missing',
      assessedAt: '2027-07-31T00:00:00.000Z',
    })).rejects.toThrow('Tenant not found');
  });

  it('rejects an invalid assessment time even for an empty tenant', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a', 2);

    await expect(buildRetentionJobPlan(db, {
      tenantId: 'tenant-a',
      assessedAt: 'not-a-timestamp',
    })).rejects.toThrow('Assessment time');
  });
});
