import { createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  coachAthleteAssignments,
  testLocks,
  tests,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export const TEST_LOCK_TTL_MS = 60_000;

export type TestLockActor = AuditActorContext;

export type TestLockResult =
  | {
    status: 'ACQUIRED';
    token: string;
    ownerUserId: string;
    expiresAt: string;
  }
  | {
    status: 'LOCKED';
    ownerUserId: string;
    expiresAt: string;
  };

function requireLockActor(actor: TestLockActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may manage test locks');
  }
}

function requireToken(token: string): void {
  if (token.length < 32 || token.length > 256) {
    throw new Error('Test lock token is invalid');
  }
}

export function hashTestLockToken(token: string): string {
  requireToken(token);
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newLease(now: Date) {
  const token = crypto.randomUUID();
  return {
    token,
    tokenHash: hashTestLockToken(token),
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TEST_LOCK_TTL_MS).toISOString(),
  };
}

export async function acquireTestLock(
  db: Database,
  tenantId: string,
  actor: TestLockActor,
  testId: string,
  now = new Date(),
): Promise<TestLockResult> {
  requireLockActor(actor);

  return db.transaction(async (tx) => {
    const [test] = await tx.select().from(tests).where(and(
      eq(tests.id, testId),
      eq(tests.tenantId, tenantId),
    )).limit(1);
    if (!test || test.status !== 'IN_PROGRESS') {
      throw new Error('Only an in-progress test can be locked');
    }

    const [existing] = await tx.select().from(testLocks).where(and(
      eq(testLocks.tenantId, tenantId),
      eq(testLocks.testId, testId),
    )).limit(1);
    if (
      existing
      && existing.ownerUserId === actor.userId
      && existing.expiresAt > now.toISOString()
    ) {
      return {
        status: 'LOCKED',
        ownerUserId: existing.ownerUserId,
        expiresAt: existing.expiresAt,
      };
    }
    if (test.conductingTrainerUserId !== actor.userId) {
      return {
        status: 'LOCKED',
        ownerUserId: existing?.ownerUserId ?? test.conductingTrainerUserId,
        expiresAt: existing?.expiresAt ?? now.toISOString(),
      };
    }
    if (existing && existing.expiresAt > now.toISOString()) {
      return {
        status: 'LOCKED',
        ownerUserId: existing.ownerUserId,
        expiresAt: existing.expiresAt,
      };
    }

    const lease = newLease(now);
    if (existing) {
      const [updated] = await tx.update(testLocks).set({
        ownerUserId: actor.userId,
        tokenHash: lease.tokenHash,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        updatedAt: lease.acquiredAt,
      }).where(and(
        eq(testLocks.id, existing.id),
        eq(testLocks.tenantId, tenantId),
        eq(testLocks.expiresAt, existing.expiresAt),
      )).returning();
      if (!updated) throw new Error('Test lock changed concurrently');
    } else {
      await tx.insert(testLocks).values({
        id: crypto.randomUUID(),
        tenantId,
        testId,
        ownerUserId: actor.userId,
        tokenHash: lease.tokenHash,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        createdAt: lease.acquiredAt,
        updatedAt: lease.acquiredAt,
      });
    }

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: lease.acquiredAt,
      ...auditActorFields(actor),
      action: 'test.lock.acquired',
      entityType: 'test_lock',
      entityId: testId,
      source: 'WEB',
      before: existing ? {
        ownerUserId: existing.ownerUserId,
        expiresAt: existing.expiresAt,
      } : undefined,
      after: {
        ownerUserId: actor.userId,
        expiresAt: lease.expiresAt,
      },
    });

    return {
      status: 'ACQUIRED',
      token: lease.token,
      ownerUserId: actor.userId,
      expiresAt: lease.expiresAt,
    };
  });
}

export async function renewTestLock(
  db: Database,
  tenantId: string,
  actor: TestLockActor,
  testId: string,
  token: string,
  now = new Date(),
): Promise<TestLockResult> {
  requireLockActor(actor);
  const tokenHash = hashTestLockToken(token);
  const expiresAt = new Date(now.getTime() + TEST_LOCK_TTL_MS).toISOString();
  const [renewed] = await db.update(testLocks).set({
    expiresAt,
    updatedAt: now.toISOString(),
  }).where(and(
    eq(testLocks.tenantId, tenantId),
    eq(testLocks.testId, testId),
    eq(testLocks.ownerUserId, actor.userId),
    eq(testLocks.tokenHash, tokenHash),
    gt(testLocks.expiresAt, now.toISOString()),
  )).returning();
  if (!renewed) {
    throw new Error('Test lock is no longer active');
  }
  return {
    status: 'ACQUIRED',
    token,
    ownerUserId: actor.userId,
    expiresAt,
  };
}

export async function takeOverTestLock(
  db: Database,
  tenantId: string,
  actor: TestLockActor,
  testId: string,
  reason: string,
  now = new Date(),
): Promise<Extract<TestLockResult, { status: 'ACQUIRED' }>> {
  requireLockActor(actor);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 500) {
    throw new Error('A takeover reason between 5 and 500 characters is required');
  }

  return db.transaction(async (tx) => {
    const [test] = await tx.select().from(tests).where(and(
      eq(tests.id, testId),
      eq(tests.tenantId, tenantId),
    )).limit(1);
    if (!test || test.status !== 'IN_PROGRESS') {
      throw new Error('Only an in-progress test can be taken over');
    }
    if (actor.role === 'TRAINER') {
      const [assignment] = await tx.select({ id: coachAthleteAssignments.id })
        .from(coachAthleteAssignments)
        .where(and(
          eq(coachAthleteAssignments.tenantId, tenantId),
          eq(coachAthleteAssignments.athleteId, test.athleteId),
          eq(coachAthleteAssignments.coachUserId, actor.userId),
          isNull(coachAthleteAssignments.validUntil),
        ))
        .limit(1);
      if (!assignment) {
        throw new Error('Trainer is not assigned to the test athlete');
      }
    }

    const [existing] = await tx.select().from(testLocks).where(and(
      eq(testLocks.tenantId, tenantId),
      eq(testLocks.testId, testId),
    )).limit(1);
    const lease = newLease(now);
    if (existing) {
      await tx.update(testLocks).set({
        ownerUserId: actor.userId,
        tokenHash: lease.tokenHash,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        updatedAt: lease.acquiredAt,
      }).where(and(
        eq(testLocks.id, existing.id),
        eq(testLocks.tenantId, tenantId),
      ));
    } else {
      await tx.insert(testLocks).values({
        id: crypto.randomUUID(),
        tenantId,
        testId,
        ownerUserId: actor.userId,
        tokenHash: lease.tokenHash,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        createdAt: lease.acquiredAt,
        updatedAt: lease.acquiredAt,
      });
    }
    const [updatedTest] = await tx.update(tests).set({
      conductingTrainerUserId: actor.userId,
      currentVersion: test.currentVersion + 1,
      updatedAt: lease.acquiredAt,
    }).where(and(
      eq(tests.id, testId),
      eq(tests.tenantId, tenantId),
      eq(tests.currentVersion, test.currentVersion),
    )).returning();
    if (!updatedTest) throw new Error('Test changed concurrently during takeover');

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: lease.acquiredAt,
      ...auditActorFields(actor),
      action: 'test.lock.taken_over',
      entityType: 'test_lock',
      entityId: testId,
      source: 'WEB',
      reason: normalizedReason,
      before: {
        conductingTrainerUserId: test.conductingTrainerUserId,
        lockOwnerUserId: existing?.ownerUserId ?? null,
        lockExpiresAt: existing?.expiresAt ?? null,
      },
      after: {
        conductingTrainerUserId: actor.userId,
        lockOwnerUserId: actor.userId,
        lockExpiresAt: lease.expiresAt,
      },
    });

    return {
      status: 'ACQUIRED',
      token: lease.token,
      ownerUserId: actor.userId,
      expiresAt: lease.expiresAt,
    };
  });
}

export async function releaseTestLock(
  db: Database,
  tenantId: string,
  actor: TestLockActor,
  testId: string,
  token: string,
): Promise<void> {
  requireLockActor(actor);
  const tokenHash = hashTestLockToken(token);
  await db.transaction(async (tx) => {
    const [released] = await tx.delete(testLocks).where(and(
      eq(testLocks.tenantId, tenantId),
      eq(testLocks.testId, testId),
      eq(testLocks.ownerUserId, actor.userId),
      eq(testLocks.tokenHash, tokenHash),
    )).returning();
    if (!released) return;
    const now = new Date().toISOString();
    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'test.lock.released',
      entityType: 'test_lock',
      entityId: testId,
      source: 'WEB',
      before: {
        ownerUserId: released.ownerUserId,
        expiresAt: released.expiresAt,
      },
    });
  });
}
