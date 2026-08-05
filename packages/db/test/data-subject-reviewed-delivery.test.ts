import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import {
  DATA_SUBJECT_REVIEW_REDACTION,
  DATA_SUBJECT_REVIEW_REQUIRED,
  DATA_SUBJECT_THIRD_PARTY_REDACTION,
  type DataSubjectDeliveryReviewDecisionInput,
} from '@masters/domain';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { approveAthleteDataSubjectDeliveryReview } from '../src/services/data-subject-delivery-approval';
import { buildAthleteDataSubjectReviewedDeliverySnapshot } from '../src/services/data-subject-reviewed-delivery';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-data-subject-reviewed-delivery-${crypto.randomUUID()}.db`;
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

function decisions(decision: 'INCLUDE_ORIGINAL' | 'REDACT'):
readonly DataSubjectDeliveryReviewDecisionInput[] {
  return [{
    section: 'athlete_deletion_requests',
    rowId: 'deletion-a',
    field: 'reason',
    decision,
  }];
}

describe('reviewed data subject delivery snapshot', () => {
  it('restores an explicitly approved original free text while preserving structured third-party redactions', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions('INCLUDE_ORIGINAL'), '2026-08-05T13:00:00.000Z',
    );
    const auditBefore = await db.select().from(schema.auditEvents);

    const snapshot = await buildAthleteDataSubjectReviewedDeliverySnapshot(
      db, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T13:05:00.000Z',
    );
    const repeated = await buildAthleteDataSubjectReviewedDeliverySnapshot(
      db, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T13:06:00.000Z',
    );

    expect(snapshot.reviewedFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(repeated.reviewedFingerprint).toBe(snapshot.reviewedFingerprint);
    expect(snapshot.reviewedSource.data.athlete_deletion_requests[0]?.reason)
      .toBe('Betroffenenrecht durch Petra');
    expect(snapshot.reviewedSource.data.athlete_guardians[0]).toMatchObject({
      full_name: DATA_SUBJECT_THIRD_PARTY_REDACTION,
      email: DATA_SUBJECT_THIRD_PARTY_REDACTION,
      phone: DATA_SUBJECT_THIRD_PARTY_REDACTION,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('Betroffenenrecht durch Petra');
    expect(serialized).not.toContain('Erika Muster');
    expect(serialized).not.toContain('erika@example.test');
    expect(serialized).not.toContain(DATA_SUBJECT_REVIEW_REQUIRED);
    expect(await db.select().from(schema.auditEvents)).toEqual(auditBefore);
  });

  it('replaces a REDACT decision deterministically and never leaks the raw reviewed text', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions('REDACT'), '2026-08-05T13:00:00.000Z',
    );

    const snapshot = await buildAthleteDataSubjectReviewedDeliverySnapshot(
      db, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T13:05:00.000Z',
    );

    expect(snapshot.reviewedSource.data.athlete_deletion_requests[0]?.reason)
      .toBe(DATA_SUBJECT_REVIEW_REDACTION);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('Betroffenenrecht durch Petra');
    expect(serialized).not.toContain(DATA_SUBJECT_REVIEW_REQUIRED);
  });

  it('fails closed when the source changes after approval', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions('INCLUDE_ORIGINAL'), '2026-08-05T13:00:00.000Z',
    );

    await db.update(schema.athleteDeletionRequests)
      .set({ reason: 'Geänderter Antragstext', updatedAt: '2026-08-05T13:02:00.000Z' })
      .where(eq(schema.athleteDeletionRequests.id, 'deletion-a'));

    await expect(buildAthleteDataSubjectReviewedDeliverySnapshot(
      db, 'tenant-a', 'athlete-a', approval.id, '2026-08-05T13:05:00.000Z',
    )).rejects.toThrow(/not valid for reviewed projection/i);
  });

  it('does not allow an approval to cross the tenant or athlete boundary', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const approval = await approveAthleteDataSubjectDeliveryReview(
      db, 'tenant-a', 'athlete-a', actor, decisions('REDACT'), '2026-08-05T13:00:00.000Z',
    );

    await expect(buildAthleteDataSubjectReviewedDeliverySnapshot(
      db, 'tenant-b', 'athlete-a', approval.id, '2026-08-05T13:05:00.000Z',
    )).rejects.toThrow(/not valid for reviewed projection/i);
  });
});
