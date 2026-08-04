import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  createAthlete,
  getAthlete,
  listAthletes,
  updateAthlete,
} from '../src/services/athletes';

const input = {
  firstName: 'Petra',
  lastName: 'Muster',
  birthDate: '1992-04-18',
  referenceCategory: 'Masters A',
  heightCm: 174,
  currentWeightKgX100: 6850,
  primarySport: 'Rudern',
  primaryDiscipline: 'Einer',
  trainingStatus: 'leistungsorientiert',
};

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-athletes-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE athletes (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      linked_user_id TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      birth_date TEXT NOT NULL,
      reference_category TEXT NOT NULL,
      height_cm INTEGER NOT NULL,
      current_weight_kg_x100 INTEGER NOT NULL,
      primary_sport TEXT NOT NULL,
      primary_discipline TEXT NOT NULL,
      training_status TEXT NOT NULL,
      consent_blocked_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      actor_user_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      source TEXT NOT NULL,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      correlation_id TEXT NOT NULL,
      auth_provider TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ]);
  return drizzle(client, { schema }) as Database;
}

describe('athlete service tenant isolation', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  it('never exposes an athlete to another tenant', async () => {
    const created = await createAthlete(
      db,
      'tenant-a',
      { userId: 'admin-a', role: 'TENANT_ADMIN' },
      input,
    );

    expect(created).not.toBeNull();
    expect(await listAthletes(db, 'tenant-a')).toHaveLength(1);
    expect(await listAthletes(db, 'tenant-b')).toHaveLength(0);
    expect(await getAthlete(db, 'tenant-b', created!.id)).toBeNull();
    await expect(
      updateAthlete(
        db,
        'tenant-b',
        created!.id,
        { userId: 'admin-b', role: 'TENANT_ADMIN' },
        { ...input, currentWeightKgX100: 7000 },
      ),
    ).rejects.toThrow('Athlete not found');
  });

  it('updates inside the tenant and records audit events with auth context', async () => {
    const actor = {
      userId: 'admin-a',
      role: 'TENANT_ADMIN',
      authProvider: 'BETTER_AUTH' as const,
      sessionId: 'session-a',
    };
    const created = await createAthlete(
      db,
      'tenant-a',
      actor,
      input,
    );
    const updated = await updateAthlete(
      db,
      'tenant-a',
      created!.id,
      actor,
      { ...input, currentWeightKgX100: 6925 },
    );

    expect(updated?.currentWeightKgX100).toBe(6925);
    const auditRows = await db.select().from(schema.auditEvents);
    expect(auditRows.map((event) => event.action)).toEqual([
      'athlete.created',
      'athlete.updated',
    ]);
    expect(auditRows.every((event) => event.tenantId === 'tenant-a')).toBe(true);
    expect(auditRows.every((event) => event.authProvider === 'BETTER_AUTH')).toBe(true);
    expect(auditRows.every((event) => event.sessionId === 'session-a')).toBe(true);
  });
});
