import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  completeAthleteDeletion,
  decideAthleteDeletion,
  previewAthleteDeletion,
  requestAthleteDeletion,
} from '../src/services/deletion-requests';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/master-diagnostics-deletion-${crypto.randomUUID()}.db` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athlete_snapshots (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE consents (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, consent_type TEXT NOT NULL, status TEXT NOT NULL, granted_at TEXT, withdrawn_at TEXT, document_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athlete_guardians (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, full_name TEXT NOT NULL, relationship TEXT NOT NULL, email TEXT, phone TEXT, authority_confirmed_at TEXT NOT NULL, valid_until TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE athlete_deletion_requests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT, decision_reason TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedAthlete(db: Database, tenantId: string, athleteId: string) {
  const now = new Date().toISOString();
  await db.insert(schema.athletes).values({
    id: athleteId, tenantId, linkedUserId: null, firstName: 'Petra', lastName: 'Muster', birthDate: '1995-01-01',
    referenceCategory: 'Senior', heightCm: 175, currentWeightKgX100: 6900, primarySport: 'Rudern',
    primaryDiscipline: 'Einer', trainingStatus: 'aktiv', consentBlockedAt: null, deletedAt: null,
    createdAt: now, updatedAt: now,
  });
}

const actor = { userId: 'admin-a', role: 'TENANT_ADMIN' };

describe('athlete deletion requests', () => {
  let db: Database;
  beforeEach(async () => { db = await createTestDatabase(); });

  it('keeps preview and lifecycle tenant scoped', async () => {
    await seedAthlete(db, 'tenant-a', 'athlete-a');
    const preview = await previewAthleteDeletion(db, 'tenant-a', 'athlete-a');
    expect(preview.strategy).toBe('SOFT_DELETE_AND_RETAIN_AUDIT');
    await expect(previewAthleteDeletion(db, 'tenant-b', 'athlete-a')).rejects.toThrow('Athlete not found');

    const request = await requestAthleteDeletion(db, 'tenant-a', 'athlete-a', actor, 'Betroffenenantrag');
    const [blocked] = await db.select().from(schema.athletes);
    expect(blocked?.consentBlockedAt).toBeTruthy();
    await expect(requestAthleteDeletion(db, 'tenant-a', 'athlete-a', actor, 'Doppelter Antrag')).rejects.toThrow('already exists');

    await decideAthleteDeletion(db, 'tenant-a', 'athlete-a', request.id, actor, 'APPROVED', 'Identität geprüft');
    await completeAthleteDeletion(db, 'tenant-a', 'athlete-a', request.id, actor, 'Aufbewahrungspflichten geprüft');

    const [athlete] = await db.select().from(schema.athletes);
    const [completed] = await db.select().from(schema.athleteDeletionRequests);
    expect(athlete?.deletedAt).toBeTruthy();
    expect(completed?.status).toBe('COMPLETED');
    const events = await db.select().from(schema.auditEvents);
    expect(events.map((event) => event.action)).toEqual([
      'athlete.deletion_requested',
      'athlete.deletion_approved',
      'athlete.deletion_completed',
    ]);
  });

  it('unblocks the athlete after a rejected request', async () => {
    await seedAthlete(db, 'tenant-a', 'athlete-a');
    const request = await requestAthleteDeletion(db, 'tenant-a', 'athlete-a', actor, 'Antrag gestellt');
    await decideAthleteDeletion(db, 'tenant-a', 'athlete-a', request.id, actor, 'REJECTED', 'Identität nicht bestätigt');
    const [athlete] = await db.select().from(schema.athletes);
    expect(athlete?.consentBlockedAt).toBeNull();
  });
});
