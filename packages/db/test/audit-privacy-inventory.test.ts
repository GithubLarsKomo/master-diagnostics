import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { inventoryAthleteAuditPrivacyMaintenance } from '../src/services/audit-privacy-inventory';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({
    url: `file:/tmp/master-diagnostics-audit-privacy-${crypto.randomUUID()}.db`,
  });
  await client.batch([
    `CREATE TABLE athletes (
      id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL,
      reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL,
      current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL,
      primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL,
      consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE athlete_snapshots (
      id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE athlete_guardians (
      id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL,
      full_name TEXT NOT NULL, relationship TEXT NOT NULL, email TEXT, phone TEXT,
      authority_confirmed_at TEXT NOT NULL, valid_until TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE audit_events (
      id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT,
      correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedAthlete(db: Database) {
  const now = '2026-01-01T00:00:00.000Z';
  await db.insert(schema.athletes).values({
    id: 'athlete-a',
    tenantId: 'tenant-a',
    linkedUserId: 'user-petra',
    firstName: 'Petra',
    lastName: 'Neu',
    birthDate: '1992-04-18',
    referenceCategory: 'Masters A',
    heightCm: 174,
    currentWeightKgX100: 6850,
    primarySport: 'Rudern',
    primaryDiscipline: 'Einer',
    trainingStatus: 'leistungsorientiert',
    consentBlockedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.athleteSnapshots).values({
    id: 'snapshot-a',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    snapshotJson: JSON.stringify({
      id: 'athlete-a',
      tenantId: 'tenant-a',
      linkedUserId: 'user-petra',
      firstName: 'Petra',
      lastName: 'Altname',
      birthDate: '1992-04-18',
    }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.athleteGuardians).values({
    id: 'guardian-a',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    fullName: 'Erika Altname',
    relationship: 'Mutter',
    email: 'erika@example.test',
    phone: '+49 170 1234567',
    authorityConfirmedAt: now,
    validUntil: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedAuditEvent(
  db: Database,
  input: {
    id: string;
    tenantId?: string;
    action: string;
    reason?: string | null;
    beforeJson?: string | null;
    afterJson?: string | null;
  },
) {
  const occurredAt = `2026-01-0${input.id.at(-1) ?? '1'}T00:00:00.000Z`;
  await db.insert(schema.auditEvents).values({
    id: input.id,
    tenantId: input.tenantId ?? 'tenant-a',
    occurredAt,
    actorUserId: 'admin-a',
    actorRole: 'TENANT_ADMIN',
    action: input.action,
    entityType: 'athlete',
    entityId: 'athlete-a',
    source: 'WEB',
    reason: input.reason ?? null,
    beforeJson: input.beforeJson ?? null,
    afterJson: input.afterJson ?? null,
    correlationId: `corr-${input.id}`,
    authProvider: 'BETTER_AUTH',
    sessionId: 'session-a',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

describe('legacy audit privacy inventory', () => {
  it('finds known historic athlete and guardian identifiers without returning their values', async () => {
    const db = await createTestDatabase();
    await seedAthlete(db);

    await seedAuditEvent(db, {
      id: 'event-1',
      action: 'athlete.updated.legacy',
      beforeJson: JSON.stringify({ firstName: 'Petra', lastName: 'Altname' }),
      afterJson: JSON.stringify({ firstName: 'Petra', lastName: 'Neu' }),
    });
    await seedAuditEvent(db, {
      id: 'event-2',
      action: 'athlete.deletion_requested.legacy',
      reason: 'Betroffenenantrag Petra Altname, geboren 1992-04-18',
      afterJson: JSON.stringify({ athleteId: 'athlete-a', status: 'REQUESTED' }),
    });
    await seedAuditEvent(db, {
      id: 'event-3',
      action: 'guardian.registered.legacy',
      afterJson: JSON.stringify({
        athleteId: 'athlete-a',
        fullName: 'Erika Altname',
        email: 'erika@example.test',
        phone: '+49 170 1234567',
      }),
    });
    await seedAuditEvent(db, {
      id: 'event-4',
      action: 'athlete.updated.v2',
      beforeJson: JSON.stringify({
        auditSchemaVersion: 2,
        firstName: '[REDACTED]',
        lastName: '[REDACTED]',
        birthDate: '[REDACTED]',
        currentWeightKgX100: 6850,
      }),
      afterJson: JSON.stringify({
        auditSchemaVersion: 2,
        firstName: '[REDACTED]',
        lastName: '[REDACTED]',
        birthDate: '[REDACTED]',
        currentWeightKgX100: 6925,
      }),
    });
    await seedAuditEvent(db, {
      id: 'event-5',
      tenantId: 'tenant-b',
      action: 'foreign.legacy',
      reason: 'Petra Altname 1992-04-18',
    });

    const before = await db.select().from(schema.auditEvents);
    const inventory = await inventoryAthleteAuditPrivacyMaintenance(
      db,
      'tenant-a',
      'athlete-a',
    );
    const after = await db.select().from(schema.auditEvents);

    expect(inventory).toMatchObject({
      mode: 'READ_ONLY',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      scannedEventCount: 4,
      candidateCount: 3,
    });
    expect(inventory.candidates.map((candidate) => ({
      id: candidate.auditEventId,
      locations: candidate.matches.map((match) => match.location),
    }))).toEqual([
      { id: 'event-1', locations: ['BEFORE_JSON', 'AFTER_JSON'] },
      { id: 'event-2', locations: ['REASON'] },
      { id: 'event-3', locations: ['AFTER_JSON'] },
    ]);
    expect(inventory.candidates[1]?.matches[0]?.identifierClasses).toEqual([
      'ATHLETE_BIRTH_DATE',
      'ATHLETE_NAME',
    ]);
    expect(inventory.candidates[2]?.matches[0]?.identifierClasses).toEqual([
      'ATHLETE_NAME',
      'GUARDIAN_CONTACT',
      'GUARDIAN_NAME',
    ]);

    const serializedInventory = JSON.stringify(inventory);
    expect(serializedInventory).not.toContain('Petra');
    expect(serializedInventory).not.toContain('Altname');
    expect(serializedInventory).not.toContain('Erika');
    expect(serializedInventory).not.toContain('1992-04-18');
    expect(serializedInventory).not.toContain('erika@example.test');
    expect(serializedInventory).not.toContain('1234567');
    expect(after).toEqual(before);
  });

  it('fails closed when the athlete is not in the requested tenant', async () => {
    const db = await createTestDatabase();
    await seedAthlete(db);

    await expect(inventoryAthleteAuditPrivacyMaintenance(
      db,
      'tenant-b',
      'athlete-a',
    )).rejects.toThrow('Athlete not found');
  });
});
