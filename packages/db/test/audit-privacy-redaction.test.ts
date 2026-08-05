import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { appendAuditEvent } from '../src/services/audit';
import {
  AUDIT_PRIVACY_REDACTED_JSON,
  AUDIT_PRIVACY_REDACTED_TEXT,
  redactHistoricalAuditEventForAthlete,
} from '../src/services/audit-privacy-redaction';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-audit-privacy-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

async function seedReadyAthlete(db: Database, options: {
  athleteId?: string;
  linkedUserId?: string | null;
  testEndedAt?: string;
  deletedAt?: string;
}) {
  const athleteId = options.athleteId ?? 'athlete-a';
  const linkedUserId = options.linkedUserId ?? 'athlete-user-a';
  const createdAt = '2019-01-01T00:00:00.000Z';
  const deletedAt = options.deletedAt ?? '2025-01-03T00:00:00.000Z';

  await db.insert(schema.tenants).values({
    id: 'tenant-a',
    slug: 'tenant-a',
    name: 'Tenant A',
    deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin',
    locale: 'de',
    retentionYears: 1,
    createdAt,
    updatedAt: createdAt,
  });
  if (linkedUserId) {
    await db.insert(schema.users).values({
      id: linkedUserId,
      email: `${linkedUserId}@example.test`,
      displayName: 'Athlete User',
      preferredLocale: 'de',
      createdAt,
      updatedAt: createdAt,
    });
  }
  await db.insert(schema.athletes).values({
    id: athleteId,
    tenantId: 'tenant-a',
    linkedUserId,
    firstName: 'Petra',
    lastName: 'Muster',
    birthDate: '1980-01-01',
    referenceCategory: 'MASTERS',
    heightCm: 175,
    currentWeightKgX100: 6900,
    primarySport: 'ROWING',
    primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED',
    consentBlockedAt: deletedAt,
    deletedAt,
    createdAt,
    updatedAt: deletedAt,
  });
  const testEndedAt = options.testEndedAt ?? '2020-01-01T11:00:00.000Z';
  await db.insert(schema.tests).values({
    id: 'test-a',
    tenantId: 'tenant-a',
    athleteId,
    deviceType: 'ROWERG',
    status: 'RELEASED',
    conductingTrainerUserId: 'trainer-a',
    startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: testEndedAt,
    releasedAt: testEndedAt,
    currentVersion: 3,
    createdAt: '2020-01-01T09:00:00.000Z',
    updatedAt: testEndedAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a',
    tenantId: 'tenant-a',
    athleteId,
    status: 'COMPLETED',
    reason: 'Betroffenenrecht',
    requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z',
    decisionReason: 'Freigegeben',
    completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: deletedAt,
  });
  return { athleteId, linkedUserId };
}

const adminActor = {
  userId: 'admin-a',
  role: 'TENANT_ADMIN',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};

describe('controlled historical audit privacy redaction', () => {
  it('allows only the fixed one-way redaction and keeps the redaction proof immutable', async () => {
    const db = await createTestDatabase();
    const { athleteId, linkedUserId } = await seedReadyAthlete(db, {});
    const event = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      occurredAt: '2021-01-01T00:00:00.000Z',
      actorUserId: linkedUserId,
      actorRole: 'ATHLETE',
      authProvider: 'BETTER_AUTH',
      sessionId: 'athlete-session-a',
      action: 'athlete.updated',
      entityType: 'athlete',
      entityId: athleteId,
      source: 'WEB',
      reason: 'Petra Muster requested correction',
      before: { firstName: 'Petra', lastName: 'Muster', athleteId },
      after: { firstName: 'Petra-Maria', lastName: 'Muster', athleteId },
    });

    const result = await redactHistoricalAuditEventForAthlete(
      db,
      'tenant-a',
      athleteId,
      adminActor,
      {
        auditEventId: event.id,
        maintenanceReference: 'PRIVACY/TICKET-123',
        assessedAt: '2026-08-05T10:00:00.000Z',
      },
    );

    expect(result.redactedFields).toEqual([
      'actorUserId',
      'sessionId',
      'reason',
      'beforeJson',
      'afterJson',
    ]);
    expect(result.event).toMatchObject({
      id: event.id,
      actorUserId: null,
      sessionId: null,
      action: 'athlete.updated',
      entityType: 'athlete',
      entityId: athleteId,
      reason: AUDIT_PRIVACY_REDACTED_TEXT,
      beforeJson: AUDIT_PRIVACY_REDACTED_JSON,
      afterJson: AUDIT_PRIVACY_REDACTED_JSON,
    });

    const redactions = await db.select().from(schema.auditEventPrivacyRedactions);
    expect(redactions).toHaveLength(1);
    expect(redactions[0]).toMatchObject({
      auditEventId: event.id,
      subjectAthleteId: athleteId,
      redactionVersion: 1,
      redactActorUserId: true,
      redactSessionId: true,
      redactReason: true,
      redactBeforeJson: true,
      redactAfterJson: true,
      requestedByUserId: 'admin-a',
      maintenanceReference: 'PRIVACY/TICKET-123',
    });

    const auditRows = await db.select().from(schema.auditEvents);
    expect(auditRows.map((row) => row.action)).toEqual([
      'athlete.updated',
      'audit.privacy_redacted',
    ]);
    expect(auditRows[1]?.afterJson).toContain('PRIVACY/TICKET-123');
    expect(auditRows[1]?.afterJson).not.toContain('Petra');

    await expect(db.$client.execute({
      sql: 'UPDATE audit_events SET action = ? WHERE id = ?',
      args: ['tampered', event.id],
    })).rejects.toThrow('audit events are immutable');
    await expect(db.$client.execute({
      sql: 'UPDATE audit_events SET before_json = ? WHERE id = ?',
      args: ['{}', event.id],
    })).rejects.toThrow('audit events are immutable');
    await expect(db.$client.execute({
      sql: 'DELETE FROM audit_events WHERE id = ?',
      args: [event.id],
    })).rejects.toThrow('audit events are immutable');
    await expect(db.$client.execute({
      sql: 'UPDATE audit_event_privacy_redactions SET maintenance_reference = ? WHERE audit_event_id = ?',
      args: ['changed', event.id],
    })).rejects.toThrow('audit privacy redactions are immutable');
    await expect(db.$client.execute({
      sql: 'DELETE FROM audit_event_privacy_redactions WHERE audit_event_id = ?',
      args: [event.id],
    })).rejects.toThrow('audit privacy redactions are immutable');

    await expect(redactHistoricalAuditEventForAthlete(
      db,
      'tenant-a',
      athleteId,
      adminActor,
      {
        auditEventId: event.id,
        maintenanceReference: 'PRIVACY/TICKET-124',
        assessedAt: '2026-08-05T10:00:00.000Z',
      },
    )).rejects.toThrow('already been privacy redacted');
  });

  it('rejects unrelated audit rows without creating an authorization record', async () => {
    const db = await createTestDatabase();
    const { athleteId } = await seedReadyAthlete(db, { linkedUserId: null });
    const event = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      action: 'tenant.export.created',
      entityType: 'tenant',
      entityId: 'tenant-a',
      source: 'WEB',
      after: { format: 'encrypted' },
    });

    await expect(redactHistoricalAuditEventForAthlete(
      db,
      'tenant-a',
      athleteId,
      adminActor,
      {
        auditEventId: event.id,
        maintenanceReference: 'PRIVACY/TICKET-125',
        assessedAt: '2026-08-05T10:00:00.000Z',
      },
    )).rejects.toThrow('not linked to the athlete');

    expect(await db.select().from(schema.auditEventPrivacyRedactions)).toHaveLength(0);
    const [unchanged] = await db.select().from(schema.auditEvents);
    expect(unchanged?.afterJson).toBe('{"format":"encrypted"}');
  });

  it('fails closed while retention is still active and for non-admin actors', async () => {
    const db = await createTestDatabase();
    const { athleteId } = await seedReadyAthlete(db, {
      linkedUserId: null,
      testEndedAt: '2026-01-01T11:00:00.000Z',
    });
    const event = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      action: 'athlete.updated',
      entityType: 'athlete',
      entityId: athleteId,
      source: 'WEB',
      after: { firstName: 'Petra', athleteId },
    });

    await expect(redactHistoricalAuditEventForAthlete(
      db,
      'tenant-a',
      athleteId,
      adminActor,
      {
        auditEventId: event.id,
        maintenanceReference: 'PRIVACY/TICKET-126',
        assessedAt: '2026-08-05T10:00:00.000Z',
      },
    )).rejects.toThrow('RETENTION_ACTIVE');

    await expect(redactHistoricalAuditEventForAthlete(
      db,
      'tenant-a',
      athleteId,
      { userId: 'trainer-a', role: 'TRAINER' },
      {
        auditEventId: event.id,
        maintenanceReference: 'PRIVACY/TICKET-127',
        assessedAt: '2027-08-05T10:00:00.000Z',
      },
    )).rejects.toThrow('Only tenant admins');

    expect(await db.select().from(schema.auditEventPrivacyRedactions)).toHaveLength(0);
  });
});
