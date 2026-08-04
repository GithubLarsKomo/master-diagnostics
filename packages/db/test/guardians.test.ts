import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { assertGuardianRequirement, listGuardians, registerGuardian, revokeGuardian } from '../src/services/guardians';

async function createTestDatabase(): Promise<Database> {
  const url = `file:/tmp/master-diagnostics-guardians-${crypto.randomUUID()}.db`;
  const client = createClient({ url });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athlete_guardians (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, full_name TEXT NOT NULL, relationship TEXT NOT NULL, email TEXT, phone TEXT, authority_confirmed_at TEXT NOT NULL, valid_until TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedAthlete(db: Database, tenantId: string, athleteId: string, birthDate: string) {
  const now = new Date().toISOString();
  await db.insert(schema.athletes).values({
    id: athleteId, tenantId, linkedUserId: null, firstName: 'Junior', lastName: 'Muster', birthDate,
    referenceCategory: 'Junior', heightCm: 170, currentWeightKgX100: 6200,
    primarySport: 'Rudern', primaryDiscipline: 'Einer', trainingStatus: 'aktiv',
    consentBlockedAt: null, deletedAt: null, createdAt: now, updatedAt: now,
  });
}

describe('guardian workflow', () => {
  let db: Database;
  beforeEach(async () => { db = await createTestDatabase(); });

  it('requires an active guardian for a minor and keeps tenants isolated', async () => {
    await seedAthlete(db, 'tenant-a', 'athlete-a', '2012-05-01');
    await expect(assertGuardianRequirement(db, 'tenant-a', 'athlete-a', new Date('2026-07-29T00:00:00Z')))
      .rejects.toThrow('Active guardian required');

    const guardian = await registerGuardian(db, 'tenant-a', 'athlete-a', { userId: 'admin-a', role: 'TENANT_ADMIN' }, {
      fullName: 'Erika Muster', relationship: 'Mutter', email: 'erika@example.test',
    });
    await expect(assertGuardianRequirement(db, 'tenant-a', 'athlete-a', new Date('2026-07-29T00:00:00Z'))).resolves.toBeUndefined();
    await expect(listGuardians(db, 'tenant-b', 'athlete-a')).rejects.toThrow('Athlete not found');

    await revokeGuardian(db, 'tenant-a', 'athlete-a', guardian.id, { userId: 'admin-a', role: 'TENANT_ADMIN' }, 'Vertretung beendet');
    await expect(assertGuardianRequirement(db, 'tenant-a', 'athlete-a', new Date('2026-07-29T00:00:00Z')))
      .rejects.toThrow('Active guardian required');
  });

  it('does not require a guardian for an adult and audits lifecycle events', async () => {
    await seedAthlete(db, 'tenant-a', 'athlete-adult', '1990-05-01');
    await expect(assertGuardianRequirement(db, 'tenant-a', 'athlete-adult', new Date('2026-07-29T00:00:00Z'))).resolves.toBeUndefined();
    const guardian = await registerGuardian(db, 'tenant-a', 'athlete-adult', { userId: 'admin-a', role: 'TENANT_ADMIN' }, {
      fullName: 'Max Muster', relationship: 'Bevollmächtigter',
    });
    await revokeGuardian(db, 'tenant-a', 'athlete-adult', guardian.id, { userId: 'admin-a', role: 'TENANT_ADMIN' }, 'Vollmacht beendet');
    const events = await db.select().from(schema.auditEvents);
    expect(events.map((event) => event.action)).toEqual(['guardian.registered', 'guardian.revoked']);
  });
});
