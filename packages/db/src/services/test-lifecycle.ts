import {
  canTransition,
  classifyStageDuration,
  TEST_START_SAFETY_CHECKLIST_VERSION,
  validateTestTerminationDetails,
  type TestTerminationReason,
} from '@masters/domain';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athletes,
  coachAthleteAssignments,
  testPlanSnapshots,
  testLocks,
  testSafetyChecklistConfirmations,
  testStages,
  testTerminationEvents,
  tests,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import { hashTestLockToken } from './test-locks';
import { buildTimerFromSnapshot } from './test-timer';

export type TestLifecycleActor = AuditActorContext;

export interface FinishTestInput {
  reason: TestTerminationReason;
  notes?: string | null;
  lockToken: string;
  activeElapsedSeconds: number;
}

interface FinishPlanSnapshot {
  protocolVersion?: {
    partialInclusionPercent?: unknown;
  };
}

function partialInclusionPercent(snapshotJson: string): number {
  let snapshot: FinishPlanSnapshot;
  try {
    snapshot = JSON.parse(snapshotJson) as FinishPlanSnapshot;
  } catch {
    throw new Error('Immutable test plan snapshot is invalid');
  }
  const value = snapshot.protocolVersion?.partialInclusionPercent;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new Error('Immutable test plan snapshot has no valid partial inclusion threshold');
  }
  return value as number;
}

function requireStartRole(actor: TestLifecycleActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may start tests');
  }
}

function requireFinishRole(actor: TestLifecycleActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may finish tests');
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

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'test.started',
      entityType: 'test',
      entityId: testId,
      source: 'WEB',
      before: {
        status: context.test.status,
        version: context.test.currentVersion,
      },
      after: {
        status: started.status,
        version: started.currentVersion,
        startedAt: started.startedAt,
        planSnapshotId: planSnapshot.id,
        safetyConfirmationId: safetyConfirmation.id,
      },
    });

    return started;
  });
}

export async function finishTest(
  db: Database,
  tenantId: string,
  actor: TestLifecycleActor,
  testId: string,
  input: FinishTestInput,
) {
  requireFinishRole(actor);
  const details = validateTestTerminationDetails(input);
  if (
    !Number.isFinite(input.activeElapsedSeconds)
    || input.activeElapsedSeconds < 0
  ) {
    throw new Error('Active elapsed seconds must be a non-negative finite number');
  }

  return db.transaction(async (tx) => {
    const [runningTest] = await tx
      .select()
      .from(tests)
      .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
      .limit(1);
    if (!runningTest) {
      throw new Error('Running test not found');
    }
    if (!canTransition(runningTest.status, 'DATA_REVIEW')) {
      throw new Error(`Test cannot finish from status ${runningTest.status}`);
    }
    if (runningTest.conductingTrainerUserId !== actor.userId) {
      throw new Error('Only the conducting trainer may finish the test');
    }

    const now = new Date().toISOString();
    const [lock] = await tx.select().from(testLocks).where(and(
      eq(testLocks.tenantId, tenantId),
      eq(testLocks.testId, testId),
      eq(testLocks.ownerUserId, actor.userId),
      eq(testLocks.tokenHash, hashTestLockToken(input.lockToken)),
    )).limit(1);
    if (!lock || lock.expiresAt <= now) {
      throw new Error('An active test lock is required to finish the test');
    }
    if (!runningTest.startedAt) {
      throw new Error('Running test has no start time');
    }
    const startedAtMs = Date.parse(runningTest.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      throw new Error('Running test has an invalid start time');
    }
    const maximumCredibleElapsedSeconds = (
      Date.parse(now) - startedAtMs
    ) / 1_000 + 5;
    if (input.activeElapsedSeconds > maximumCredibleElapsedSeconds) {
      throw new Error('Active elapsed seconds exceed the elapsed wall time');
    }
    const [planSnapshot] = await tx.select().from(testPlanSnapshots).where(and(
      eq(testPlanSnapshots.tenantId, tenantId),
      eq(testPlanSnapshots.testId, testId),
    )).limit(1);
    if (!planSnapshot) {
      throw new Error('Immutable test plan snapshot is required to finish the test');
    }
    const timerPlan = buildTimerFromSnapshot(
      planSnapshot.snapshotJson,
      planSnapshot.maximumStages,
    );
    const normalizedActiveElapsedSeconds = Math.min(
      Math.floor(input.activeElapsedSeconds),
      timerPlan.totalDurationSeconds,
    );
    const thresholdPercent = partialInclusionPercent(planSnapshot.snapshotJson);
    const existingStages = await tx.select().from(testStages).where(and(
      eq(testStages.tenantId, tenantId),
      eq(testStages.testId, testId),
    ));
    const stageClassifications: Array<{
      stageNumber: number;
      beforeActualSeconds: number | null;
      afterActualSeconds: number;
      beforeQualityStatus: string;
      afterQualityStatus: string;
    }> = [];
    for (const stage of existingStages) {
      const phase = timerPlan.phases.find(
        (candidate) => (
          candidate.kind === 'STAGE'
          && candidate.stageNumber === stage.stageNumber
        ),
      );
      if (!phase) {
        throw new Error(`Stage ${stage.stageNumber} is not part of the immutable test plan`);
      }
      const elapsedInStage = Math.min(
        phase.durationSeconds,
        Math.max(0, normalizedActiveElapsedSeconds - phase.startsAtSeconds),
      );
      if (elapsedInStage <= 0) continue;
      const classification = classifyStageDuration(
        phase.durationSeconds,
        elapsedInStage,
        thresholdPercent,
      );
      const [updatedStage] = await tx.update(testStages).set({
        actualSeconds: classification.actualSeconds,
        qualityStatus: classification.qualityStatus,
        currentVersion: stage.currentVersion + 1,
        updatedAt: now,
      }).where(and(
        eq(testStages.id, stage.id),
        eq(testStages.tenantId, tenantId),
        eq(testStages.currentVersion, stage.currentVersion),
      )).returning();
      if (!updatedStage) {
        throw new Error(`Stage ${stage.stageNumber} changed concurrently`);
      }
      stageClassifications.push({
        stageNumber: stage.stageNumber,
        beforeActualSeconds: stage.actualSeconds,
        afterActualSeconds: classification.actualSeconds,
        beforeQualityStatus: stage.qualityStatus,
        afterQualityStatus: classification.qualityStatus,
      });
    }
    const [finished] = await tx
      .update(tests)
      .set({
        status: 'DATA_REVIEW',
        endedAt: now,
        currentVersion: runningTest.currentVersion + 1,
        updatedAt: now,
      })
      .where(and(
        eq(tests.id, testId),
        eq(tests.tenantId, tenantId),
        eq(tests.status, 'IN_PROGRESS'),
        eq(tests.currentVersion, runningTest.currentVersion),
      ))
      .returning();
    if (!finished) {
      throw new Error('Test changed concurrently and was not finished');
    }

    const [terminationEvent] = await tx.insert(testTerminationEvents).values({
      id: crypto.randomUUID(),
      tenantId,
      testId,
      reason: details.reason,
      notes: details.notes,
      endedByUserId: actor.userId,
      endedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!terminationEvent) {
      throw new Error('Test termination event was not recorded');
    }
    await tx.delete(testLocks).where(and(
      eq(testLocks.id, lock.id),
      eq(testLocks.tenantId, tenantId),
    ));

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'test.finished',
      entityType: 'test',
      entityId: testId,
      source: 'WEB',
      reason: details.reason,
      before: {
        status: runningTest.status,
        version: runningTest.currentVersion,
      },
      after: {
        status: finished.status,
        version: finished.currentVersion,
        endedAt: finished.endedAt,
        reason: details.reason,
        notes: details.notes,
        terminationEventId: terminationEvent.id,
        activeElapsedSeconds: normalizedActiveElapsedSeconds,
        partialInclusionPercent: thresholdPercent,
        stageClassifications,
      },
    });

    return finished;
  });
}
