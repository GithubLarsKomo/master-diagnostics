import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  recoveryMeasurements,
  restMeasurements,
  testPlanSnapshots,
  testStages,
  tests,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export type ReviewMeasurementKind = 'REST' | 'STAGE' | 'RECOVERY';
export type ReviewQualityStatus =
  | 'VALID'
  | 'PARTIAL'
  | 'EXCLUDED'
  | 'MISSING'
  | 'MANUALLY_CORRECTED';

export type TestReviewActor = AuditActorContext;

export interface TestReviewRow {
  kind: ReviewMeasurementKind;
  stageNumber: number | null;
  entityId: string | null;
  targetWatts: number | null;
  plannedSeconds: number | null;
  actualSeconds: number | null;
  heartRate: number | null;
  lactateValueX100: number | null;
  lactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  measuredAt: string | null;
  qualityStatus: ReviewQualityStatus | null;
  notes: string | null;
  version: number;
}

export interface CorrectTestMeasurementInput {
  kind: ReviewMeasurementKind;
  stageNumber: number | null;
  expectedVersion: number;
  heartRate: number | null;
  lactateValueX100: number | null;
  lactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  measuredAt: string | null;
  qualityStatus: ReviewQualityStatus | null;
  notes: string | null;
  reason: string;
}

export type CorrectTestMeasurementResult =
  | { status: 'APPLIED'; row: TestReviewRow }
  | { status: 'CONFLICT'; row: TestReviewRow };

function requireReviewActor(actor: TestReviewActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may review test measurements');
  }
}

function stageRow(
  stageNumber: number,
  targetWatts: number,
  plannedSeconds: number,
  stage?: typeof testStages.$inferSelect,
): TestReviewRow {
  return {
    kind: 'STAGE',
    stageNumber,
    entityId: stage?.id ?? null,
    targetWatts,
    plannedSeconds: stage?.plannedSeconds ?? plannedSeconds,
    actualSeconds: stage?.actualSeconds ?? null,
    heartRate: stage?.endHeartRate ?? null,
    lactateValueX100: stage?.lactateValueX100 ?? null,
    lactateQualifier: stage?.lactateQualifier ?? null,
    measuredAt: stage?.lactateMeasuredAt ?? null,
    qualityStatus: stage?.qualityStatus ?? 'MISSING',
    notes: stage?.notes ?? null,
    version: stage?.currentVersion ?? 0,
  };
}

function restRow(
  measurement?: typeof restMeasurements.$inferSelect,
): TestReviewRow {
  return {
    kind: 'REST',
    stageNumber: null,
    entityId: measurement?.id ?? null,
    targetWatts: null,
    plannedSeconds: null,
    actualSeconds: null,
    heartRate: measurement?.heartRate ?? null,
    lactateValueX100: measurement?.lactateValueX100 ?? null,
    lactateQualifier: measurement?.lactateQualifier ?? null,
    measuredAt: measurement?.measuredAt ?? null,
    qualityStatus: null,
    notes: null,
    version: measurement?.currentVersion ?? 0,
  };
}

function recoveryRow(
  measurement?: typeof recoveryMeasurements.$inferSelect,
): TestReviewRow {
  return {
    kind: 'RECOVERY',
    stageNumber: null,
    entityId: measurement?.id ?? null,
    targetWatts: null,
    plannedSeconds: null,
    actualSeconds: null,
    heartRate: measurement?.heartRate ?? null,
    lactateValueX100: measurement?.lactateValueX100 ?? null,
    lactateQualifier: measurement?.lactateQualifier ?? null,
    measuredAt: measurement?.measuredAt ?? null,
    qualityStatus: null,
    notes: null,
    version: measurement?.currentVersion ?? 0,
  };
}

async function requireReviewContext(
  db: Database,
  tenantId: string,
  actor: TestReviewActor,
  testId: string,
) {
  requireReviewActor(actor);
  const [context] = await db
    .select({ test: tests, plan: testPlanSnapshots })
    .from(tests)
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.tenantId, tenantId),
      eq(testPlanSnapshots.testId, tests.id),
    ))
    .where(and(
      eq(tests.tenantId, tenantId),
      eq(tests.id, testId),
    ))
    .limit(1);
  if (!context) throw new Error('Test review context not found');
  if (context.test.status !== 'DATA_REVIEW') {
    throw new Error(`Measurements cannot be reviewed while test is ${context.test.status}`);
  }
  if (
    actor.role !== 'TENANT_ADMIN'
    && context.test.conductingTrainerUserId !== actor.userId
  ) {
    throw new Error('Only the conducting trainer may review this test');
  }
  return context;
}

export async function getTestReviewRows(
  db: Database,
  tenantId: string,
  actor: TestReviewActor,
  testId: string,
): Promise<TestReviewRow[]> {
  const context = await requireReviewContext(db, tenantId, actor, testId);
  const [rest, stages, recovery] = await Promise.all([
    db.select().from(restMeasurements).where(and(
      eq(restMeasurements.tenantId, tenantId),
      eq(restMeasurements.testId, testId),
    )).limit(1),
    db.select().from(testStages).where(and(
      eq(testStages.tenantId, tenantId),
      eq(testStages.testId, testId),
    )),
    db.select().from(recoveryMeasurements).where(and(
      eq(recoveryMeasurements.tenantId, tenantId),
      eq(recoveryMeasurements.testId, testId),
    )).limit(1),
  ]);
  const stagesByNumber = new Map(stages.map((stage) => [stage.stageNumber, stage]));
  const stageSeconds = plannedStageSeconds(context.plan.snapshotJson);
  return [
    restRow(rest[0]),
    ...Array.from(
      { length: context.plan.maximumStages },
      (_, index) => {
        const stageNumber = index + 1;
        return stageRow(
          stageNumber,
          context.plan.startWatts
            + context.plan.incrementWatts * index,
          stageSeconds,
          stagesByNumber.get(stageNumber),
        );
      },
    ),
    recoveryRow(recovery[0]),
  ];
}

function validateCorrection(input: CorrectTestMeasurementInput): string {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new Error('A correction reason between 5 and 500 characters is required');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('Expected version must be a non-negative integer');
  }
  if (
    input.heartRate !== null
    && (
      !Number.isInteger(input.heartRate)
      || input.heartRate < 20
      || input.heartRate > 250
    )
  ) {
    throw new Error('Heart rate is outside the supported range');
  }
  if (
    input.lactateValueX100 !== null
    && (
      !Number.isInteger(input.lactateValueX100)
      || input.lactateValueX100 < 50
      || input.lactateValueX100 > 3_000
    )
  ) {
    throw new Error('Lactate value is outside the supported range');
  }
  if (
    (input.lactateValueX100 === null)
    !== (input.lactateQualifier === null)
  ) {
    throw new Error('Lactate value and qualifier must both be present or absent');
  }
  if (
    input.measuredAt !== null
    && !Number.isFinite(Date.parse(input.measuredAt))
  ) {
    throw new Error('Measurement time must be a valid ISO-8601 timestamp');
  }
  if (input.kind === 'STAGE') {
    if (
      !Number.isInteger(input.stageNumber)
      || input.stageNumber === null
      || input.stageNumber < 1
      || input.stageNumber > 12
    ) {
      throw new Error('Stage number is invalid');
    }
    if (!input.qualityStatus) throw new Error('Stage quality status is required');
    if (
      input.qualityStatus === 'MISSING'
      && (
        input.heartRate !== null
        || input.lactateValueX100 !== null
        || input.measuredAt !== null
      )
    ) {
      throw new Error('A missing stage cannot contain measurement values');
    }
  } else {
    if (input.stageNumber !== null || input.qualityStatus !== null) {
      throw new Error('Rest and recovery measurements have no stage quality status');
    }
  }
  if (input.notes !== null && input.notes.trim().length > 2_000) {
    throw new Error('Measurement notes must not exceed 2000 characters');
  }
  return reason;
}

function measurementChanged(
  before: TestReviewRow,
  input: CorrectTestMeasurementInput,
): boolean {
  return (
    before.heartRate !== input.heartRate
    || before.lactateValueX100 !== input.lactateValueX100
    || before.lactateQualifier !== input.lactateQualifier
    || before.measuredAt !== input.measuredAt
  );
}

function plannedStageSeconds(snapshotJson: string): number {
  let snapshot: { protocolVersion?: { stageSeconds?: unknown } };
  try {
    snapshot = JSON.parse(snapshotJson) as typeof snapshot;
  } catch {
    throw new Error('Immutable test plan snapshot is invalid');
  }
  const value = snapshot.protocolVersion?.stageSeconds;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error('Immutable test plan snapshot has no valid stage duration');
  }
  return value as number;
}

export async function correctTestMeasurement(
  db: Database,
  tenantId: string,
  actor: TestReviewActor,
  testId: string,
  input: CorrectTestMeasurementInput,
): Promise<CorrectTestMeasurementResult> {
  const reason = validateCorrection(input);
  const context = await requireReviewContext(db, tenantId, actor, testId);

  return db.transaction(async (tx) => {
    const [currentTest] = await tx.select().from(tests).where(and(
      eq(tests.tenantId, tenantId),
      eq(tests.id, testId),
    )).limit(1);
    if (!currentTest || currentTest.status !== 'DATA_REVIEW') {
      throw new Error('Test is no longer available for data review');
    }
    if (
      actor.role !== 'TENANT_ADMIN'
      && currentTest.conductingTrainerUserId !== actor.userId
    ) {
      throw new Error('Only the conducting trainer may review this test');
    }
    const now = new Date().toISOString();
    let before: TestReviewRow;
    let after: TestReviewRow;

    if (input.kind === 'REST') {
      const [existing] = await tx.select().from(restMeasurements).where(and(
        eq(restMeasurements.tenantId, tenantId),
        eq(restMeasurements.testId, testId),
      )).limit(1);
      before = restRow(existing);
      if (before.version !== input.expectedVersion) {
        return { status: 'CONFLICT', row: before };
      }
      if (!measurementChanged(before, input)) {
        throw new Error('Correction does not change the rest measurement');
      }
      if (existing) {
        const [updated] = await tx.update(restMeasurements).set({
          heartRate: input.heartRate,
          lactateValueX100: input.lactateValueX100,
          lactateQualifier: input.lactateQualifier,
          measuredAt: input.measuredAt,
          currentVersion: existing.currentVersion + 1,
          updatedAt: now,
        }).where(and(
          eq(restMeasurements.id, existing.id),
          eq(restMeasurements.tenantId, tenantId),
          eq(restMeasurements.currentVersion, input.expectedVersion),
        )).returning();
        if (!updated) return { status: 'CONFLICT', row: before };
        after = restRow(updated);
      } else {
        const [created] = await tx.insert(restMeasurements).values({
          id: crypto.randomUUID(),
          tenantId,
          testId,
          heartRate: input.heartRate,
          lactateValueX100: input.lactateValueX100,
          lactateQualifier: input.lactateQualifier,
          measuredAt: input.measuredAt,
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        }).returning();
        if (!created) throw new Error('Rest measurement was not created');
        after = restRow(created);
      }
    } else if (input.kind === 'RECOVERY') {
      const [existing] = await tx.select().from(recoveryMeasurements).where(and(
        eq(recoveryMeasurements.tenantId, tenantId),
        eq(recoveryMeasurements.testId, testId),
      )).limit(1);
      before = recoveryRow(existing);
      if (before.version !== input.expectedVersion) {
        return { status: 'CONFLICT', row: before };
      }
      if (!measurementChanged(before, input)) {
        throw new Error('Correction does not change the recovery measurement');
      }
      if (existing) {
        const [updated] = await tx.update(recoveryMeasurements).set({
          heartRate: input.heartRate,
          lactateValueX100: input.lactateValueX100,
          lactateQualifier: input.lactateQualifier,
          measuredAt: input.measuredAt,
          currentVersion: existing.currentVersion + 1,
          updatedAt: now,
        }).where(and(
          eq(recoveryMeasurements.id, existing.id),
          eq(recoveryMeasurements.tenantId, tenantId),
          eq(recoveryMeasurements.currentVersion, input.expectedVersion),
        )).returning();
        if (!updated) return { status: 'CONFLICT', row: before };
        after = recoveryRow(updated);
      } else {
        const [created] = await tx.insert(recoveryMeasurements).values({
          id: crypto.randomUUID(),
          tenantId,
          testId,
          targetOffsetSeconds: 300,
          heartRate: input.heartRate,
          lactateValueX100: input.lactateValueX100,
          lactateQualifier: input.lactateQualifier,
          measuredAt: input.measuredAt,
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        }).returning();
        if (!created) throw new Error('Recovery measurement was not created');
        after = recoveryRow(created);
      }
    } else {
      const stageNumber = input.stageNumber!;
      if (stageNumber > context.plan.maximumStages) {
        throw new Error('Stage is not part of the immutable test plan');
      }
      const targetWatts = context.plan.startWatts
        + context.plan.incrementWatts * (stageNumber - 1);
      const stageSeconds = plannedStageSeconds(context.plan.snapshotJson);
      const [existing] = await tx.select().from(testStages).where(and(
        eq(testStages.tenantId, tenantId),
        eq(testStages.testId, testId),
        eq(testStages.stageNumber, stageNumber),
      )).limit(1);
      before = stageRow(stageNumber, targetWatts, stageSeconds, existing);
      if (before.version !== input.expectedVersion) {
        return { status: 'CONFLICT', row: before };
      }
      const notes = input.notes?.trim() || null;
      if (
        !measurementChanged(before, input)
        && before.qualityStatus === input.qualityStatus
        && before.notes === notes
      ) {
        throw new Error('Correction does not change the stage measurement');
      }
      const qualityStatus = (
        measurementChanged(before, input)
        && input.qualityStatus !== 'EXCLUDED'
        && input.qualityStatus !== 'MISSING'
      )
        ? 'MANUALLY_CORRECTED'
        : input.qualityStatus!;
      if (existing) {
        const [updated] = await tx.update(testStages).set({
          endHeartRate: input.heartRate,
          lactateValueX100: input.lactateValueX100,
          lactateQualifier: input.lactateQualifier,
          lactateMeasuredAt: input.measuredAt,
          qualityStatus,
          notes,
          currentVersion: existing.currentVersion + 1,
          updatedAt: now,
        }).where(and(
          eq(testStages.id, existing.id),
          eq(testStages.tenantId, tenantId),
          eq(testStages.currentVersion, input.expectedVersion),
        )).returning();
        if (!updated) return { status: 'CONFLICT', row: before };
        after = stageRow(stageNumber, targetWatts, stageSeconds, updated);
      } else {
        const [created] = await tx.insert(testStages).values({
          id: crypto.randomUUID(),
          tenantId,
          testId,
          stageNumber,
          targetWatts,
          plannedSeconds: stageSeconds,
          endHeartRate: input.heartRate,
          lactateValueX100: input.lactateValueX100,
          lactateQualifier: input.lactateQualifier,
          lactateMeasuredAt: input.measuredAt,
          qualityStatus,
          notes,
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        }).returning();
        if (!created) throw new Error('Stage measurement was not created');
        after = stageRow(stageNumber, targetWatts, stageSeconds, created);
      }
    }

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'test.measurement.corrected',
      entityType: `test_measurement.${input.kind.toLowerCase()}`,
      entityId: after.entityId,
      source: 'WEB',
      reason,
      before,
      after,
    });
    return { status: 'APPLIED', row: after };
  });
}
