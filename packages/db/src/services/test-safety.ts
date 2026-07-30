import {
  getMissingTestStartSafetyItems,
  TEST_START_SAFETY_CHECKLIST_VERSION,
  type TestStartSafetyChecklistConfirmation,
} from '@masters/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athletes,
  auditEvents,
  testSafetyChecklistConfirmations,
  tests,
} from '../schema';

export interface TestSafetyActor {
  userId: string;
  role: string;
}

export type TestStartReadinessBlocker =
  | 'TEST_NOT_FOUND'
  | 'TEST_NOT_PLANNED'
  | 'ATHLETE_NOT_AVAILABLE'
  | 'ATHLETE_CONSENT_BLOCKED'
  | 'SAFETY_CHECKLIST_NOT_CONFIRMED';

function requireSafetyRole(actor: TestSafetyActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may confirm test safety');
  }
}

export async function confirmTestSafetyChecklist(
  db: Database,
  tenantId: string,
  actor: TestSafetyActor,
  testId: string,
  confirmation: TestStartSafetyChecklistConfirmation,
) {
  requireSafetyRole(actor);
  const missingItems = getMissingTestStartSafetyItems(confirmation);
  if (missingItems.length > 0) {
    throw new Error(`Every safety item must be confirmed: ${missingItems.join(', ')}`);
  }

  return db.transaction(async (tx) => {
    const [plannedTest] = await tx
      .select({ test: tests, athlete: athletes })
      .from(tests)
      .innerJoin(athletes, and(
        eq(athletes.id, tests.athleteId),
        eq(athletes.tenantId, tenantId),
      ))
      .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
      .limit(1);
    if (!plannedTest) {
      throw new Error('Planned test not found');
    }
    if (plannedTest.test.status !== 'PLANNED') {
      throw new Error('Safety may only be confirmed for a planned test');
    }
    if (plannedTest.test.conductingTrainerUserId !== actor.userId) {
      throw new Error('Only the conducting trainer may confirm test safety');
    }
    if (plannedTest.athlete.deletedAt) {
      throw new Error('Athlete is not available for diagnostic use');
    }
    if (plannedTest.athlete.consentBlockedAt) {
      throw new Error('Athlete is blocked from diagnostic use');
    }

    const [existing] = await tx
      .select({ id: testSafetyChecklistConfirmations.id })
      .from(testSafetyChecklistConfirmations)
      .where(and(
        eq(testSafetyChecklistConfirmations.tenantId, tenantId),
        eq(testSafetyChecklistConfirmations.testId, testId),
      ))
      .limit(1);
    if (existing) {
      throw new Error('Test safety checklist has already been confirmed');
    }

    const now = new Date().toISOString();
    const checklist = {
      id: crypto.randomUUID(),
      tenantId,
      testId,
      checklistVersion: TEST_START_SAFETY_CHECKLIST_VERSION,
      confirmationsJson: JSON.stringify(confirmation),
      confirmedByUserId: actor.userId,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(testSafetyChecklistConfirmations).values(checklist);
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId,
      occurredAt: now,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'test.safety_checklist_confirmed',
      entityType: 'test_safety_checklist_confirmation',
      entityId: checklist.id,
      source: 'WEB',
      correlationId: crypto.randomUUID(),
      afterJson: JSON.stringify({
        testId,
        checklistVersion: TEST_START_SAFETY_CHECKLIST_VERSION,
        confirmedItems: Object.keys(confirmation),
      }),
      createdAt: now,
      updatedAt: now,
    });
    return checklist;
  });
}

export async function getTestStartReadiness(
  db: Database,
  tenantId: string,
  testId: string,
): Promise<{
  ready: boolean;
  blockers: TestStartReadinessBlocker[];
  confirmation: typeof testSafetyChecklistConfirmations.$inferSelect | null;
}> {
  const [plannedTest] = await db
    .select({ test: tests, athlete: athletes })
    .from(tests)
    .innerJoin(athletes, and(
      eq(athletes.id, tests.athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
    .limit(1);
  if (!plannedTest) {
    return { ready: false, blockers: ['TEST_NOT_FOUND'], confirmation: null };
  }

  const [confirmation] = await db
    .select()
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
  const blockers: TestStartReadinessBlocker[] = [];
  if (plannedTest.test.status !== 'PLANNED') blockers.push('TEST_NOT_PLANNED');
  if (plannedTest.athlete.deletedAt) blockers.push('ATHLETE_NOT_AVAILABLE');
  if (plannedTest.athlete.consentBlockedAt) blockers.push('ATHLETE_CONSENT_BLOCKED');
  if (!confirmation) blockers.push('SAFETY_CHECKLIST_NOT_CONFIRMED');

  return { ready: blockers.length === 0, blockers, confirmation: confirmation ?? null };
}
