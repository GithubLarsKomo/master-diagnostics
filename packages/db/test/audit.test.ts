import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { appendAuditEvent } from '../src/services/audit';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-audit-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

describe('append-only audit service', () => {
  it('appends immutable event rows with centrally serialized before/after data', async () => {
    const db = await createTestDatabase();
    const first = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      actorRole: 'TENANT_ADMIN',
      action: 'athlete.updated',
      entityType: 'athlete',
      entityId: 'athlete-a',
      source: 'WEB',
      before: { firstName: 'Max' },
      after: { firstName: 'Maximilian' },
      correlationId: 'correlation-a',
      occurredAt: '2026-08-03T18:00:00.000Z',
      recordedAt: '2026-08-03T18:00:02.000Z',
      authProvider: 'BETTER_AUTH',
      sessionId: 'session-a',
    });
    await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      action: 'tenant.export.created',
      entityType: 'tenant',
      entityId: 'tenant-a',
      source: 'API',
    });

    expect(Object.isFrozen(first)).toBe(true);
    const rows = await db.$client.execute({
      sql: 'SELECT action, occurred_at, created_at, updated_at, before_json, after_json, correlation_id, auth_provider, session_id FROM audit_events ORDER BY occurred_at, id',
      args: [],
    });
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      action: 'athlete.updated',
      occurred_at: '2026-08-03T18:00:00.000Z',
      created_at: '2026-08-03T18:00:02.000Z',
      updated_at: '2026-08-03T18:00:02.000Z',
      before_json: '{"firstName":"Max"}',
      after_json: '{"firstName":"Maximilian"}',
      correlation_id: 'correlation-a',
      auth_provider: 'BETTER_AUTH',
      session_id: 'session-a',
    });
  });

  it('participates in the caller transaction and rolls back with domain writes', async () => {
    const db = await createTestDatabase();

    await expect(db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        tenantId: 'tenant-a',
        action: 'test.rollback-probe',
        entityType: 'test',
        entityId: 'test-a',
        source: 'TEST',
      });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    const result = await db.$client.execute('SELECT COUNT(*) AS count FROM audit_events');
    expect(Number(result.rows[0]?.count ?? -1)).toBe(0);
  });

  it('rejects direct updates and deletes at the database boundary', async () => {
    const db = await createTestDatabase();
    const event = await appendAuditEvent(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      actorRole: 'TENANT_ADMIN',
      action: 'test.append-only-probe',
      entityType: 'test',
      entityId: 'test-a',
      source: 'TEST',
    });

    await expect(db.$client.execute({
      sql: 'UPDATE audit_events SET action = ? WHERE id = ?',
      args: ['tampered', event.id],
    })).rejects.toThrow('audit events are immutable');
    await expect(db.$client.execute({
      sql: 'DELETE FROM audit_events WHERE id = ?',
      args: [event.id],
    })).rejects.toThrow('audit events are immutable');

    const rows = await db.$client.execute({
      sql: 'SELECT action FROM audit_events WHERE id = ?',
      args: [event.id],
    });
    expect(rows.rows[0]).toMatchObject({ action: 'test.append-only-probe' });
  });
});
