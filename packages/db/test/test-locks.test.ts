import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  acquireTestLock,
  releaseTestLock,
  renewTestLock,
  takeOverTestLock,
} from '../src/services/test-locks';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-test-locks-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE test_locks (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX test_lock_test_uq ON test_locks (tenant_id, test_id)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER DEFAULT false NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

const conductor = {
  userId: 'trainer-a',
  role: 'TRAINER',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'session-trainer-a',
};
const replacement = {
  userId: 'trainer-b',
  role: 'TRAINER',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'session-trainer-b',
};
const startedAt = '2026-07-30T10:00:00.000Z';

async function seedContext(db: Database): Promise<void> {
  await db.insert(schema.tests).values({
    id: 'test-a',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    deviceType: 'BIKEERG',
    status: 'IN_PROGRESS',
    conductingTrainerUserId: conductor.userId,
    startedAt,
    currentVersion: 2,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  await db.insert(schema.coachAthleteAssignments).values({
    id: 'assignment-b',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    coachUserId: replacement.userId,
    validFrom: startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
}

describe('exclusive test locks', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedContext(db);
  });

  it('acquires, renews and releases a single expiring lease', async () => {
    const acquired = await acquireTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      new Date('2026-07-30T10:01:00.000Z'),
    );
    expect(acquired).toMatchObject({
      status: 'ACQUIRED',
      ownerUserId: conductor.userId,
      expiresAt: '2026-07-30T10:02:00.000Z',
    });
    if (acquired.status !== 'ACQUIRED') throw new Error('Expected acquired lock');

    await expect(acquireTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      new Date('2026-07-30T10:01:10.000Z'),
    )).resolves.toMatchObject({ status: 'LOCKED' });
    await expect(renewTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      acquired.token,
      new Date('2026-07-30T10:01:20.000Z'),
    )).resolves.toMatchObject({ expiresAt: '2026-07-30T10:02:20.000Z' });
    await expect(renewTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      '22222222-2222-4222-8222-222222222222',
      new Date('2026-07-30T10:01:30.000Z'),
    )).rejects.toThrow('no longer active');

    await releaseTestLock(db, 'tenant-a', conductor, 'test-a', acquired.token);
    expect(await db.select().from(schema.testLocks)).toHaveLength(0);
    const auditEvents = await db.select().from(schema.auditEvents);
    expect(auditEvents.map((event) => event.action))
      .toEqual(['test.lock.acquired', 'test.lock.released']);
    expect(auditEvents.every((event) => event.authProvider === 'BETTER_AUTH')).toBe(true);
    expect(auditEvents.every((event) => event.sessionId === 'session-trainer-a')).toBe(true);
  });

  it('reacquires an expired lease without silently replacing an active lease', async () => {
    const first = await acquireTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      new Date('2026-07-30T10:01:00.000Z'),
    );
    const activeAttempt = await acquireTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      new Date('2026-07-30T10:01:59.000Z'),
    );
    const afterExpiry = await acquireTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      new Date('2026-07-30T10:02:01.000Z'),
    );

    expect(first.status).toBe('ACQUIRED');
    expect(activeAttempt.status).toBe('LOCKED');
    expect(afterExpiry.status).toBe('ACQUIRED');
    if (first.status === 'ACQUIRED' && afterExpiry.status === 'ACQUIRED') {
      expect(afterExpiry.token).not.toBe(first.token);
    }
  });

  it('audits controlled takeover and invalidates the previous owner', async () => {
    const original = await acquireTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      new Date('2026-07-30T10:01:00.000Z'),
    );
    if (original.status !== 'ACQUIRED') throw new Error('Expected acquired lock');

    const takeover = await takeOverTestLock(
      db,
      'tenant-a',
      replacement,
      'test-a',
      'Trainerwechsel wegen Geräteausfall',
      new Date('2026-07-30T10:01:10.000Z'),
    );
    expect(takeover.ownerUserId).toBe(replacement.userId);
    const [test] = await db.select().from(schema.tests)
      .where(eq(schema.tests.id, 'test-a'));
    expect(test).toMatchObject({
      conductingTrainerUserId: replacement.userId,
      currentVersion: 3,
    });
    await expect(renewTestLock(
      db,
      'tenant-a',
      conductor,
      'test-a',
      original.token,
      new Date('2026-07-30T10:01:20.000Z'),
    )).rejects.toThrow('no longer active');
    const takeoverAudit = (await db.select().from(schema.auditEvents))
      .find((event) => event.action === 'test.lock.taken_over');
    expect(takeoverAudit).toMatchObject({
      actorUserId: replacement.userId,
      reason: 'Trainerwechsel wegen Geräteausfall',
      authProvider: 'BETTER_AUTH',
      sessionId: 'session-trainer-b',
    });
  });

  it('rejects cross-tenant, unassigned and unauthorized takeover attempts', async () => {
    await expect(takeOverTestLock(
      db,
      'tenant-a',
      { userId: 'trainer-c', role: 'TRAINER' },
      'test-a',
      'Unberechtigter Wechsel',
    )).rejects.toThrow('not assigned');
    await expect(takeOverTestLock(
      db,
      'tenant-b',
      replacement,
      'test-a',
      'Falscher Mandant',
    )).rejects.toThrow('in-progress test');
    await expect(acquireTestLock(
      db,
      'tenant-a',
      { userId: 'athlete-a', role: 'ATHLETE' },
      'test-a',
    )).rejects.toThrow('Only trainers and tenant admins');
    expect(await db.select().from(schema.testLocks)).toHaveLength(0);
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });
});
