import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { getAthleteIrreversibleProcessingPrecheck } from '../src/services/irreversible-processing';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-irreversible-precheck-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function seedTenant(db: Database, id: string, retentionYears = 2): Promise<void> {
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
  athleteId: string,
  options: {
    linkedUserId?: string | null;
    createdAt?: string;
    consentBlockedAt?: string | null;
    deletedAt?: string | null;
  } = {},
): Promise<void> {
  const createdAt = options.createdAt ?? '2020-01-01T00:00:00.000Z';
  await db.insert(schema.athletes).values({
    id: athleteId,
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

async function seedDeletionRequest(
  db: Database,
  tenantId: string,
  athleteId: string,
  options: {
    id?: string;
    status?: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
    completedAt?: string | null;
  } = {},
): Promise<void> {
  const requestedAt = '2024-01-01T00:00:00.000Z';
  const status = options.status ?? 'COMPLETED';
  await db.insert(schema.athleteDeletionRequests).values({
    id: options.id ?? `${athleteId}-deletion`,
    tenantId,
    athleteId,
    status,
    reason: 'Betroffenenantrag',
    requestedAt,
    decidedAt: status === 'REQUESTED' ? null : '2024-02-01T00:00:00.000Z',
    decisionReason: status === 'REQUESTED' ? null : 'Identität geprüft',
    completedAt: options.completedAt ?? (status === 'COMPLETED'
      ? '2025-02-01T00:00:00.000Z'
      : null),
    createdAt: requestedAt,
    updatedAt: options.completedAt ?? requestedAt,
  });
}

describe('irreversible athlete processing precheck', () => {
  it('passes only as a read-only necessary precheck after retention and deletion workflow completion', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2020-01-01T00:00:00.000Z',
      consentBlockedAt: '2025-01-01T00:00:00.000Z',
      deletedAt: '2025-02-01T00:00:00.000Z',
    });
    await seedDeletionRequest(db, 'tenant-a', 'athlete-a');

    const beforeAthletes = await db.select().from(schema.athletes);
    const beforeRequests = await db.select().from(schema.athleteDeletionRequests);

    const result = await getAthleteIrreversibleProcessingPrecheck(
      db,
      'tenant-a',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    );

    expect(result).toMatchObject({
      mode: 'READ_ONLY',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      assessedAt: '2027-07-31T00:00:00.000Z',
      passesPrecheck: true,
      blockers: [],
      state: {
        consentBlockedAt: '2025-01-01T00:00:00.000Z',
        deletedAt: '2025-02-01T00:00:00.000Z',
        completedDeletionRequestId: 'athlete-a-deletion',
        completedDeletionRequestAt: '2025-02-01T00:00:00.000Z',
      },
    });
    expect(result.retention.eligibleForIrreversibleAction).toBe(true);
    expect(await db.select().from(schema.athletes)).toEqual(beforeAthletes);
    expect(await db.select().from(schema.athleteDeletionRequests)).toEqual(beforeRequests);
  });

  it('fails closed when retention, use blocking, soft delete, or workflow completion are missing', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    await seedDeletionRequest(db, 'tenant-a', 'athlete-a', {
      status: 'APPROVED',
      completedAt: null,
    });

    const result = await getAthleteIrreversibleProcessingPrecheck(
      db,
      'tenant-a',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    );

    expect(result.passesPrecheck).toBe(false);
    expect(result.blockers).toEqual([
      'RETENTION_ACTIVE',
      'USAGE_NOT_BLOCKED',
      'SOFT_DELETE_NOT_COMPLETED',
      'DELETION_WORKFLOW_NOT_COMPLETED',
    ]);
  });

  it('does not let future soft-delete state satisfy a historical assessment', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2020-01-01T00:00:00.000Z',
      consentBlockedAt: '2028-01-01T00:00:00.000Z',
      deletedAt: '2028-02-01T00:00:00.000Z',
    });
    await seedDeletionRequest(db, 'tenant-a', 'athlete-a', {
      completedAt: '2028-02-01T00:00:00.000Z',
    });

    const result = await getAthleteIrreversibleProcessingPrecheck(
      db,
      'tenant-a',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    );

    expect(result.retention.eligibleForIrreversibleAction).toBe(true);
    expect(result.blockers).toEqual([
      'USAGE_NOT_BLOCKED',
      'SOFT_DELETE_NOT_COMPLETED',
      'DELETION_WORKFLOW_NOT_COMPLETED',
    ]);
  });

  it('keeps linked no-test profiles in manual review and remains tenant scoped', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedTenant(db, 'tenant-b');
    await seedUser(db, 'user-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      linkedUserId: 'user-a',
      createdAt: '2020-01-01T00:00:00.000Z',
      consentBlockedAt: '2025-01-01T00:00:00.000Z',
      deletedAt: '2025-02-01T00:00:00.000Z',
    });
    await seedDeletionRequest(db, 'tenant-a', 'athlete-a');

    const result = await getAthleteIrreversibleProcessingPrecheck(
      db,
      'tenant-a',
      'athlete-a',
      '2030-01-01T00:00:00.000Z',
    );
    expect(result.blockers).toEqual(['RETENTION_MANUAL_REVIEW']);
    await expect(getAthleteIrreversibleProcessingPrecheck(
      db,
      'tenant-b',
      'athlete-a',
    )).rejects.toThrow('Athlete not found');
  });

  it('rejects invalid assessment timestamps', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a');

    await expect(getAthleteIrreversibleProcessingPrecheck(
      db,
      'tenant-a',
      'athlete-a',
      'not-a-timestamp',
    )).rejects.toThrow('Assessment time');
  });
});
