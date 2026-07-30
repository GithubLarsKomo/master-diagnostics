import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { finishTest } from '../src/services/test-lifecycle';
import { hashTestLockToken } from '../src/services/test-locks';

const lockToken = '11111111-1111-4111-8111-111111111111';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-lifecycle-finish-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_termination_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, reason TEXT NOT NULL, notes TEXT, ended_by_user_id TEXT NOT NULL, ended_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_termination_event_test_uq ON test_termination_events (tenant_id, test_id)`,
    `CREATE TRIGGER test_termination_events_immutable_update BEFORE UPDATE ON test_termination_events BEGIN SELECT RAISE(ABORT, 'test termination events are immutable'); END`,
    `CREATE TRIGGER test_termination_events_immutable_delete BEFORE DELETE ON test_termination_events BEGIN SELECT RAISE(ABORT, 'test termination events are immutable'); END`,
    `CREATE TABLE test_locks (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_lock_test_uq ON test_locks (tenant_id, test_id)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

async function seedTests(db: Database): Promise<void> {
  const now = '2026-07-30T09:00:00.000Z';
  await db.insert(schema.tests).values([
    {
      id: 'test-running', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'BIKEERG',
      status: 'IN_PROGRESS', conductingTrainerUserId: 'trainer-a', startedAt: now,
      currentVersion: 2, createdAt: now, updatedAt: now,
    },
    {
      id: 'test-running-other', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG',
      status: 'IN_PROGRESS', conductingTrainerUserId: 'trainer-a', startedAt: now,
      currentVersion: 4, createdAt: now, updatedAt: now,
    },
    {
      id: 'test-planned', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'BIKEERG',
      status: 'PLANNED', conductingTrainerUserId: 'trainer-a', currentVersion: 1,
      createdAt: now, updatedAt: now,
    },
    {
      id: 'test-b', tenantId: 'tenant-b', athleteId: 'athlete-b', deviceType: 'ROWERG',
      status: 'IN_PROGRESS', conductingTrainerUserId: 'trainer-b', startedAt: now,
      currentVersion: 2, createdAt: now, updatedAt: now,
    },
  ]);
  await db.insert(schema.testLocks).values([
    {
      id: 'lock-running', tenantId: 'tenant-a', testId: 'test-running',
      ownerUserId: 'trainer-a', tokenHash: hashTestLockToken(lockToken),
      acquiredAt: now, expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: now, updatedAt: now,
    },
    {
      id: 'lock-running-other', tenantId: 'tenant-a', testId: 'test-running-other',
      ownerUserId: 'trainer-a', tokenHash: hashTestLockToken(lockToken),
      acquiredAt: now, expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: now, updatedAt: now,
    },
  ]);
}

const trainer = { userId: 'trainer-a', role: 'TRAINER' };

describe('test lifecycle finish transition', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedTests(db);
  });

  it('atomically moves a running test to data review with an immutable event and audit', async () => {
    const finished = await finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'REGULAR_EXHAUSTION',
      lockToken,
    });

    expect(finished).toMatchObject({
      id: 'test-running', status: 'DATA_REVIEW', currentVersion: 3,
    });
    expect(finished.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [termination] = await db.select().from(schema.testTerminationEvents);
    expect(termination).toMatchObject({
      tenantId: 'tenant-a', testId: 'test-running', reason: 'REGULAR_EXHAUSTION',
      notes: null, endedByUserId: 'trainer-a', endedAt: finished.endedAt,
    });
    const [audit] = await db.select().from(schema.auditEvents);
    expect(audit).toMatchObject({
      tenantId: 'tenant-a', actorUserId: 'trainer-a', action: 'test.finished',
      entityType: 'test', entityId: 'test-running', reason: 'REGULAR_EXHAUSTION',
    });
    expect(JSON.parse(audit!.beforeJson!)).toEqual({ status: 'IN_PROGRESS', version: 2 });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({
      status: 'DATA_REVIEW', version: 3, reason: 'REGULAR_EXHAUSTION', notes: null,
      terminationEventId: termination!.id,
    });

    await expect(finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'VOLUNTARY_STOP',
      lockToken,
    })).rejects.toThrow('cannot finish from status DATA_REVIEW');
    expect(await db.select().from(schema.testTerminationEvents)).toHaveLength(1);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(1);
  });

  it('records a normalized explanatory note for OTHER', async () => {
    await finishTest(db, 'tenant-a', trainer, 'test-running-other', {
      reason: 'OTHER', notes: '  Athlete requested a protocol-specific stop  ',
      lockToken,
    });

    const [termination] = await db
      .select()
      .from(schema.testTerminationEvents)
      .where(eq(schema.testTerminationEvents.testId, 'test-running-other'));
    expect(termination).toMatchObject({
      reason: 'OTHER', notes: 'Athlete requested a protocol-specific stop',
    });
  });

  it('allows safe stopping without rechecking consent or an active assignment', async () => {
    const finished = await finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'PAIN_OR_DISCOMFORT', notes: 'Chest discomfort reported',
      lockToken,
    });

    expect(finished.status).toBe('DATA_REVIEW');
  });

  it('rejects invalid actors, tenants, states and details without partial writes', async () => {
    await expect(finishTest(db, 'tenant-a', { userId: 'athlete-a', role: 'ATHLETE' }, 'test-running', {
      reason: 'VOLUNTARY_STOP',
      lockToken,
    })).rejects.toThrow('Only trainers and tenant admins');
    await expect(finishTest(db, 'tenant-a', { userId: 'trainer-other', role: 'TRAINER' }, 'test-running', {
      reason: 'VOLUNTARY_STOP',
      lockToken,
    })).rejects.toThrow('Only the conducting trainer');
    await expect(finishTest(db, 'tenant-a', trainer, 'test-b', {
      reason: 'TECHNICAL_FAILURE',
      lockToken,
    })).rejects.toThrow('Running test not found');
    await expect(finishTest(db, 'tenant-a', trainer, 'test-planned', {
      reason: 'PROTOCOL_ERROR',
      lockToken,
    })).rejects.toThrow('cannot finish from status PLANNED');
    await expect(finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'OTHER', notes: '  ',
      lockToken,
    })).rejects.toThrow('notes are required for OTHER');
    await expect(finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'UNKNOWN' as 'OTHER',
      lockToken,
    })).rejects.toThrow('Invalid test termination reason');
    await expect(finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'VOLUNTARY_STOP',
      lockToken: '22222222-2222-4222-8222-222222222222',
    })).rejects.toThrow('active test lock');

    expect(await db.select().from(schema.testTerminationEvents)).toHaveLength(0);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
    const [running] = await db.select().from(schema.tests)
      .where(eq(schema.tests.id, 'test-running'));
    expect(running).toMatchObject({ status: 'IN_PROGRESS', currentVersion: 2, endedAt: null });
  });

  it('prevents direct changes to the immutable termination event', async () => {
    await finishTest(db, 'tenant-a', trainer, 'test-running', {
      reason: 'TECHNICAL_FAILURE', notes: 'Sensor disconnected',
      lockToken,
    });
    const [event] = await db.select().from(schema.testTerminationEvents);

    await expect(db.update(schema.testTerminationEvents)
      .set({ notes: 'rewritten' })
      .where(eq(schema.testTerminationEvents.id, event!.id)))
      .rejects.toThrow('Failed query: update "test_termination_events"');
    await expect(db.delete(schema.testTerminationEvents)
      .where(eq(schema.testTerminationEvents.id, event!.id)))
      .rejects.toThrow('Failed query: delete from "test_termination_events"');
    expect((await db.select().from(schema.testTerminationEvents))[0]).toMatchObject({
      notes: 'Sensor disconnected',
    });
  });
});
