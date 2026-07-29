import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  assignCoach,
  createAthleteSnapshot,
  listAthleteSnapshots,
  listCoachAssignments,
} from '../src/services/athlete-context';

const actor = { userId: 'admin-a', role: 'TENANT_ADMIN' };
let databasePath = '';
let db: Database;

async function createTestDatabase() {
  databasePath = `/tmp/master-diagnostics-athlete-context-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL, preferred_locale TEXT NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tenant_memberships (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athlete_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  const now = new Date().toISOString();
  await client.batch([
    { sql: `INSERT INTO users VALUES (?, ?, ?, 'de', NULL, ?, ?)`, args: ['coach-a', 'a@example.test', 'Coach A', now, now] },
    { sql: `INSERT INTO users VALUES (?, ?, ?, 'de', NULL, ?, ?)`, args: ['coach-b', 'b@example.test', 'Coach B', now, now] },
    { sql: `INSERT INTO tenant_memberships VALUES (?, ?, ?, 'TRAINER', 1, ?, ?)`, args: ['membership-a', 'tenant-a', 'coach-a', now, now] },
    { sql: `INSERT INTO tenant_memberships VALUES (?, ?, ?, 'TRAINER', 1, ?, ?)`, args: ['membership-b', 'tenant-a', 'coach-b', now, now] },
    { sql: `INSERT INTO athletes VALUES (?, ?, NULL, 'Petra', 'Muster', '1992-04-18', 'Masters A', 174, 6850, 'Rudern', 'Einer', 'leistungsorientiert', NULL, NULL, ?, ?)`, args: ['athlete-a', 'tenant-a', now, now] },
  ]);
  db = drizzle(client, { schema }) as Database;
}

beforeEach(createTestDatabase);
afterEach(async () => {
  const { unlink } = await import('node:fs/promises');
  await unlink(databasePath).catch(() => undefined);
});

describe('coach assignments and athlete snapshots', () => {
  it('keeps exactly one active primary coach and audits assignments', async () => {
    await assignCoach(db, 'tenant-a', 'athlete-a', 'coach-a', true, actor);
    await assignCoach(db, 'tenant-a', 'athlete-a', 'coach-b', true, actor);

    const assignments = await listCoachAssignments(db, 'tenant-a', 'athlete-a');
    expect(assignments).toHaveLength(2);
    expect(assignments.filter((assignment) => assignment.isPrimary)).toHaveLength(1);
    expect(assignments.find((assignment) => assignment.isPrimary)?.coachUserId).toBe('coach-b');

    const events = await db.select().from(schema.auditEvents);
    expect(events.map((event) => event.action)).toEqual([
      'athlete.coach_assigned',
      'athlete.coach_assigned',
    ]);
  });

  it('rejects coach and athlete access from another tenant', async () => {
    await expect(assignCoach(db, 'tenant-b', 'athlete-a', 'coach-a', true, actor))
      .rejects.toThrow('Athlete not found');
    await expect(assignCoach(db, 'tenant-a', 'athlete-a', 'unknown-coach', true, actor))
      .rejects.toThrow('Active trainer membership not found');
    expect(await listCoachAssignments(db, 'tenant-b', 'athlete-a')).toEqual([]);
  });

  it('creates immutable sequential snapshots scoped to the tenant', async () => {
    const first = await createAthleteSnapshot(db, 'tenant-a', 'athlete-a', actor);
    await db.update(schema.athletes)
      .set({ currentWeightKgX100: 7000, updatedAt: new Date().toISOString() })
      .where((await import('drizzle-orm')).eq(schema.athletes.id, 'athlete-a'));
    const second = await createAthleteSnapshot(db, 'tenant-a', 'athlete-a', actor);

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(JSON.parse(first.snapshotJson).currentWeightKgX100).toBe(6850);
    expect(JSON.parse(second.snapshotJson).currentWeightKgX100).toBe(7000);
    expect(await listAthleteSnapshots(db, 'tenant-b', 'athlete-a')).toEqual([]);

    const events = await db.select().from(schema.auditEvents);
    expect(events.filter((event) => event.action === 'athlete.snapshot_created')).toHaveLength(2);
  });
});
