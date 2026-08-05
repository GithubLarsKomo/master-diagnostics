import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { appendAuditEvent } from '../src/services/audit';
import { getAthletePseudonymizationReadiness } from '../src/services/pseudonymization-readiness';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-pseudonymization-readiness-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function seedTenant(db: Database, id: string): Promise<void> {
  const timestamp = '2020-01-01T00:00:00.000Z';
  await db.insert(schema.tenants).values({
    id,
    slug: id,
    name: id,
    deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin',
    locale: 'de',
    retentionYears: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function seedAthlete(
  db: Database,
  tenantId: string,
  athleteId: string,
  options: {
    createdAt?: string;
    consentBlockedAt?: string | null;
    deletedAt?: string | null;
  } = {},
): Promise<void> {
  const createdAt = options.createdAt ?? '2020-01-01T00:00:00.000Z';
  await db.insert(schema.athletes).values({
    id: athleteId,
    tenantId,
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
  status: 'APPROVED' | 'COMPLETED',
): Promise<string> {
  const requestId = crypto.randomUUID();
  const requestedAt = '2025-01-01T00:00:00.000Z';
  const decidedAt = '2025-01-02T00:00:00.000Z';
  const completedAt = status === 'COMPLETED' ? '2025-01-03T00:00:00.000Z' : null;
  await db.insert(schema.athleteDeletionRequests).values({
    id: requestId,
    tenantId,
    athleteId,
    status,
    reason: 'Betroffenenrecht',
    requestedAt,
    decidedAt,
    decisionReason: 'Freigegeben',
    completedAt,
    createdAt: requestedAt,
    updatedAt: completedAt ?? decidedAt,
  });
  return requestId;
}

describe('athlete pseudonymization readiness', () => {
  it('builds an approval-ready plan and inventories audit identifiers without writing', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      consentBlockedAt: '2025-01-01T00:00:00.000Z',
      deletedAt: '2025-01-03T00:00:00.000Z',
    });
    const requestId = await seedDeletionRequest(
      db,
      'tenant-a',
      'athlete-a',
      'COMPLETED',
    );

    const athleteAudit = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      action: 'athlete.created',
      entityType: 'athlete',
      entityId: 'athlete-a',
      source: 'WEB',
      after: {
        firstName: 'Petra',
        lastName: 'Muster',
        birthDate: '1980-01-01',
      },
    });
    const guardianAudit = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      action: 'athlete.guardian_registered',
      entityType: 'athlete_guardian',
      entityId: 'guardian-a',
      source: 'WEB',
      reason: 'Vertretung für Petra Muster',
      after: {
        athleteId: 'athlete-a',
        fullName: 'Max Muster',
        email: 'max@example.test',
      },
    });
    await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      action: 'tenant.export_created',
      entityType: 'tenant_export',
      entityId: 'export-a',
      source: 'WEB',
      after: { format: 'encrypted' },
    });

    const beforeAthlete = await db.select().from(schema.athletes);
    const beforeRequests = await db.select().from(schema.athleteDeletionRequests);
    const beforeAudit = await db.select().from(schema.auditEvents);

    const readiness = await getAthletePseudonymizationReadiness(
      db,
      'tenant-a',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    );

    expect(readiness).toMatchObject({
      mode: 'READ_ONLY',
      athleteId: 'athlete-a',
      eligibleForExplicitApproval: true,
      blockers: [],
      deletionRequestId: requestId,
      deletionCompletedAt: '2025-01-03T00:00:00.000Z',
      auditDirectIdentifierCount: 2,
      requiresAuditPseudonymization: true,
    });
    expect(readiness.auditEventIdsRequiringPseudonymization).toEqual([
      athleteAudit.id,
      guardianAudit.id,
    ].sort());

    expect(await db.select().from(schema.athletes)).toEqual(beforeAthlete);
    expect(await db.select().from(schema.athleteDeletionRequests)).toEqual(beforeRequests);
    expect(await db.select().from(schema.auditEvents)).toEqual(beforeAudit);
  });

  it('fails closed when retention is active even after the soft-delete workflow', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      createdAt: '2027-01-01T00:00:00.000Z',
      consentBlockedAt: '2027-02-01T00:00:00.000Z',
      deletedAt: '2027-02-03T00:00:00.000Z',
    });
    await seedDeletionRequest(db, 'tenant-a', 'athlete-a', 'COMPLETED');

    const readiness = await getAthletePseudonymizationReadiness(
      db,
      'tenant-a',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    );

    expect(readiness.eligibleForExplicitApproval).toBe(false);
    expect(readiness.blockers).toEqual(['RETENTION_ACTIVE']);
  });

  it('requires a completed deletion workflow and consistent soft-delete protection', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedAthlete(db, 'tenant-a', 'athlete-a');
    await seedDeletionRequest(db, 'tenant-a', 'athlete-a', 'APPROVED');

    const readiness = await getAthletePseudonymizationReadiness(
      db,
      'tenant-a',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    );

    expect(readiness.eligibleForExplicitApproval).toBe(false);
    expect(readiness.blockers).toEqual([
      'DELETION_WORKFLOW_NOT_COMPLETED',
      'ATHLETE_NOT_SOFT_DELETED',
      'ATHLETE_NOT_USAGE_BLOCKED',
    ]);
  });

  it('stays tenant scoped', async () => {
    const db = await createTestDatabase();
    await seedTenant(db, 'tenant-a');
    await seedTenant(db, 'tenant-b');
    await seedAthlete(db, 'tenant-a', 'athlete-a', {
      consentBlockedAt: '2025-01-01T00:00:00.000Z',
      deletedAt: '2025-01-03T00:00:00.000Z',
    });

    await expect(getAthletePseudonymizationReadiness(
      db,
      'tenant-b',
      'athlete-a',
      '2027-07-31T00:00:00.000Z',
    )).rejects.toThrow('Athlete not found');
  });
});
