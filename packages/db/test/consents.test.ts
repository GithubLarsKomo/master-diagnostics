import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { grantConsent, listConsents, withdrawConsent } from '../src/services/consents';

async function createDb(): Promise<Database> {
  const path = `/tmp/masters-consents-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${path}` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE consents (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, consent_type TEXT NOT NULL, status TEXT NOT NULL, granted_at TEXT, withdrawn_at TEXT, document_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  const now = new Date().toISOString();
  await client.execute({ sql: `INSERT INTO athletes VALUES (?, ?, NULL, 'Petra', 'Muster', '1992-04-18', 'Masters A', 174, 6850, 'Rudern', 'Einer', 'leistungsorientiert', NULL, NULL, ?, ?)`, args: ['athlete-a', 'tenant-a', now, now] });
  return drizzle(client, { schema }) as Database;
}

const actor = { userId: 'admin-a', role: 'TENANT_ADMIN' };

describe('consent workflow', () => {
  it('grants, withdraws and re-grants while maintaining the athlete block', async () => {
    const db = await createDb();
    const firstId = await grantConsent(db, 'tenant-a', 'athlete-a', actor, 'DIAGNOSTIC_TESTING', 'v1');
    let [athlete] = await db.select().from(schema.athletes);
    expect(athlete.consentBlockedAt).toBeNull();

    await withdrawConsent(db, 'tenant-a', 'athlete-a', firstId, actor, 'Athlete requested withdrawal');
    [athlete] = await db.select().from(schema.athletes);
    expect(athlete.consentBlockedAt).not.toBeNull();

    await grantConsent(db, 'tenant-a', 'athlete-a', actor, 'DIAGNOSTIC_TESTING', 'v2');
    [athlete] = await db.select().from(schema.athletes);
    expect(athlete.consentBlockedAt).toBeNull();
    expect((await listConsents(db, 'tenant-a', 'athlete-a')).map((row) => row.status)).toEqual(['GRANTED', 'WITHDRAWN']);

    const audit = await db.select().from(schema.auditEvents);
    expect(audit.map((row) => row.action)).toEqual(['consent.granted', 'consent.withdrawn', 'consent.granted']);
  });

  it('does not expose or modify consent data across tenants', async () => {
    const db = await createDb();
    const consentId = await grantConsent(db, 'tenant-a', 'athlete-a', actor, 'DIAGNOSTIC_TESTING', 'v1');
    await expect(listConsents(db, 'tenant-b', 'athlete-a')).rejects.toThrow('Athlete not found');
    await expect(withdrawConsent(db, 'tenant-b', 'athlete-a', consentId, actor, 'invalid')).rejects.toThrow('Athlete not found');
  });
});
