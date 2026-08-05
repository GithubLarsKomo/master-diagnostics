import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { DataSubjectDeliveryReviewDecisionInput } from '@masters/domain';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  approveAthleteDataSubjectDeliveryReview,
  validateAthleteDataSubjectDeliveryApproval,
} from '../src/services/data-subject-delivery-approval';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-data-subject-delivery-approval-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const createdAt = '2020-01-01T00:00:00.000Z';
const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};

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
  await db.insert(schema.users).values([
    {
      id: 'admin-a', email: 'admin-a@example.test', displayName: 'Admin A', preferredLocale: 'de',
      createdAt, updatedAt: createdAt,
    },
    {
      id: 'admin-b', email: 'admin-b@example.test', displayName: 'Admin B', preferredLocale: 'de',
      createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteGuardians).values({
    id: 'guardian-a', tenantId: 'tenant-a', athleteId: 'athlete-a', fullName: 'Erika Muster',
    relationship: 'parent', email: 'erika@example.test', phone: '+491111111',
    authorityConfirmedAt: createdAt, validUntil: null, revokedAt: null, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'REQUESTED',
    reason: 'Betroffenenrecht durch Petra', requestedAt: '2026-08-05T12:00:00.000Z',
    decidedAt: null, decisionReason: null, completedAt: null,
    createdAt: '2026-08-05T12:00:00.000Z', updatedAt: '2026-08-05T12:00:00.000Z',
  });
}

function decisions(decision: 'INCLUDE_ORIGINAL' | 'REDACT' = 'INCLUDE_ORIGINAL'):
readonly DataSubjectDeliveryReviewDecisionInput[] {
  return [{
    section: 'athlete_deletion_requests',
    rowId: 'deletion-a',
    field: 'reason',
    decision,
  }];
}

describe('data subject delivery review approval', () => {
  it('stores an immutable PII-free approval and validates it against the unchanged source', async () => {
    const db = await createTestDatabase();
    await seed(db);

    const approval = await approveAthleteDataSubjectDeliveryReview(
      db,
      'tenant-a',
      'athlete-a',
      actor,
      decisions(),
      '2026-08-05T13:00:00.000Z',
    );
    expect(approval.reviewDecisions).toEqual(decisions());
    expect(approval.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(approval.decisionsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const [stored] = await db.select().from(schema.athleteDataSubjectDeliveryApprovals);
    expect(stored).toBeDefined();
    const serializedStored = JSON.stringify(stored);
    expect(serializedStored).not.toContain('Betroffenenrecht');
    expect(serializedStored).not.toContain('Petra');
    expect(serializedStored).not.toContain('Erika Muster');
    expect(serializedStored).not.toContain('erika@example.test');

    const audit = (await db.select().from(schema.auditEvents)).find(
      (row) => row.action === 'athlete.data_subject_delivery_review_approved',
    );
    expect(audit).toBeDefined();
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain('Betroffenenrecht');
    expect(serializedAudit).not.toContain('Erika Muster');
    expect(serializedAudit).toContain(approval.sourceFingerprint);
    expect(serializedAudit).toContain(approval.decisionsFingerprint);

    const validation = await validateAthleteDataSubjectDeliveryApproval(
      db,
      'tenant-a',
      'athlete-a',
      approval.id,
      '2026-08-05T13:05:00.000Z',
    );
    expect(validation).toMatchObject({ validForDeliveryPackaging: true, blockers: [] });

    await expect(db.update(schema.athleteDataSubjectDeliveryApprovals)
      .set({ assessedAt: '2026-08-06T00:00:00.000Z' })
      .where(eq(schema.athleteDataSubjectDeliveryApprovals.id, approval.id))).rejects.toThrow();
    const [afterRejectedUpdate] = await db.select().from(schema.athleteDataSubjectDeliveryApprovals)
      .where(eq(schema.athleteDataSubjectDeliveryApprovals.id, approval.id));
    expect(afterRejectedUpdate?.assessedAt).toBe(approval.assessedAt);

    await expect(db.delete(schema.athleteDataSubjectDeliveryApprovals)
      .where(eq(schema.athleteDataSubjectDeliveryApprovals.id, approval.id))).rejects.toThrow();
    const afterRejectedDelete = await db.select().from(schema.athleteDataSubjectDeliveryApprovals)
      .where(eq(schema.athleteDataSubjectDeliveryApprovals.id, approval.id));
    expect(afterRejectedDelete).toHaveLength(1);
  });

  it('is idempotent per reviewer while allowing a second admin to independently approve', async () => {
    const db = await createTestDatabase();
    await seed(db);

    const first = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions(), '2026-08-05T13:00:00.000Z',
    );
    const repeated = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions(), '2026-08-05T13:01:00.000Z',
    );
    expect(repeated.id).toBe(first.id);

    const secondActor = {
      ...actor,
      userId: 'admin-b',
      sessionId: 'admin-session-b',
    };
    const second = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', secondActor, decisions(), '2026-08-05T13:02:00.000Z',
    );
    expect(second.id).not.toBe(first.id);
    expect(await db.select().from(schema.athleteDataSubjectDeliveryApprovals)).toHaveLength(2);
    expect((await db.select().from(schema.auditEvents)).filter(
      (row) => row.action === 'athlete.data_subject_delivery_review_approved',
    )).toHaveLength(2);
  });

  it('fails closed when decisions do not exactly cover the current review items', async () => {
    const db = await createTestDatabase();
    await seed(db);

    await expect(approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, [], '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/exactly cover current review items/i);

    await expect(approveAthleteDataSubjectDeliveryReview(
      db,
      'tenant-a',
      'athlete-a',
      actor,
      [...decisions(), {
        section: 'athletes', rowId: 'athlete-a', field: 'first_name', decision: 'REDACT' as const,
      }],
      '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/exactly cover current review items/i);
  });

  it('invalidates the approval when any subject source data changes', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions('REDACT'), '2026-08-05T13:00:00.000Z',
    );

    await db.update(schema.athletes)
      .set({ currentWeightKgX100: 7000, updatedAt: '2026-08-05T13:02:00.000Z' })
      .where(eq(schema.athletes.id, 'athlete-a'));

    const validation = await validateAthleteDataSubjectDeliveryApproval(
      db, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T13:05:00.000Z',
    );
    expect(validation.validForDeliveryPackaging).toBe(false);
    expect(validation.blockers).toContain('SOURCE_FINGERPRINT_CHANGED');
  });

  it('requires a tenant admin and the requested tenant/athlete boundary', async () => {
    const db = await createTestDatabase();
    await seed(db);

    await expect(approveAthleteDataSubjectDeliveryReview(
      db,
      'tenant-a',
      'athlete-a',
      { ...actor, role: 'TRAINER' },
      decisions(),
      '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/tenant admin/i);

    await expect(approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-b', 'athlete-a', actor, decisions(), '2026-08-05T13:00:00.000Z',
    )).rejects.toThrow(/source not found/i);
  });
});
