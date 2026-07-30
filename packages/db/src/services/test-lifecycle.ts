import {
  canTransition,
  TEST_START_SAFETY_CHECKLIST_VERSION,
} from '@masters/domain';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athletes,
  auditEvents,
  coachAthleteAssignments,
  testPlanSnapshots,
  testSafetyChecklistConfirmations,
  tests,
} from '../schema';

export interface TestLifecycleActor {
  userId: string;
  role: string;
}

function requireStartRole(actor: TestLifecycleActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may start tests');
  }
}

export async function startTest(
  db: Database,
  tenantId: string,
  actor: TestLifecycleActor,
  testId: string,
) {
  requireStartRole(actor);

  return db.transaction(async (tx) => {
    const [context] = await tx
      .select({ test: tests, athlete: athletes })
      .from(tests)
      .innerJoin(athletes, and(
        eq(athletes.id, tests.athleteId),
        eq(athletes.tenantId, tenantId),
      ))
      .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
      .limit(1);
    if (!context) {
      throw new Error('Planned test not found');
    }
    if (!canTransition(context.test.status, 'IN_PROGRESS')) {
      throw new Error(`Test cannot start from status ${context.test.status}`);
    }
    if (context.test.conductingTrainerUserId !== actor.userId) {
      throw new Error('Only the conducting trainer may start the test');
    }
    if (context.athlete.deletedAt) {
      throw new Error('Athlete is not available for diagnostic use');
    }
    if (context.athlete.consentBlockedAt) {
      throw new Error('Athlete is blocked from diagnostic use');
    }

    if (actor.role === 'TRAINER') {
      const [assignment] = await tx
        .select({ id: coachAthleteAssignments.id })
        .from(coachAthleteAssignments)
        .where(and(
          eq(coachAthleteAssignments.tenantId, tenantId),
          eq(coachAthleteAssignments.athleteId, context.test.athleteId),
          eq(coachAthleteAssignments.coachUserId, actor.userId),
          isNull(coachAthleteAssignments.validUntil),
        ))
        .limit(1);
      if (!assignment) {
        throw new Error('Conducting trainer is not assigned to athlete');
      }
    }

    const [planSnapshot] = await tx
      .select({ id: testPlanSnapshots.id })
      .from(testPlanSnapshots)
      .where(and(
        eq(testPlanSnapshots.tenantId, tenantId),
        eq(testPlanSnapshots.testId, testId),
      ))
      .limit(1);
    if (!planSnapshot) {
      throw new Error('Immutable test plan snapshot is required before start');
    }

    const [safetyConfirmation] = await tx
      .select({ id: testSafetyChecklistConfirmations.id })
      .from(testSafetyChecklistConfirmations)
      .where(and(
        eq(testSafetyChecklistConfirmations.tenantId, tenantId),
        eq(testSafetyChecklistConfirmations.testId, testId),
        eq(
          testSafetyChecklistConfirmations.checklistVersion,
          TEST_START_SAFETY_CHECKLIST_VERSION,
        ),
      ))
      .limit(1);
    if (!safetyConfirmation) {
      throw new Error('Current safety checklist confirmation is required before start');
    }

    const now = new Date().toISOString();
    const [started] = await tx
      .update(tests)
      .set({
        status: 'IN_PROGRESS',
        startedAt: now,
        currentVersion: context.test.currentVersion + 1,
        updatedAt: now,
      })
      .where(and(
        eq(tests.id, testId),
        eq(tests.tenantId, tenantId),
        eq(tests.status, 'PLANNED'),
        eq(tests.currentVersion, context.test.currentVersion),
      ))
      .returning();
    if (!started) {
      throw new Error('Test changed concurrently and was not started');
    }

    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId,
      occurredAt: now,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'test.started',
      entityType: 'test',
      entityId: testId,
      source: 'WEB',
      correlationId: crypto.randomUUID(),
      beforeJson: JSON.stringify({
        status: context.test.status,
        version: context.test.currentVersion,
      }),
      afterJson: JSON.stringify({
        status: started.status,
        version: started.currentVersion,
        startedAt: started.startedAt,
        planSnapshotId: planSnapshot.id,
        safetyConfirmationId: safetyConfirmation.id,
      }),
      createdAt: now,
      updatedAt: now,
    });

    return started;
  });
}
