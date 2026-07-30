import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  auditEvents,
  recoveryMeasurements,
  restMeasurements,
  syncOperations,
  testStages,
  tests,
} from '../schema';
import { getTestTimerPlan } from './test-timer';

export const TEST_MEASUREMENT_SYNC_OPERATION = 'TEST_MEASUREMENT_UPSERT';
export const TEST_MEASUREMENT_SYNC_SCHEMA_VERSION = '1';

export type MeasurementSyncTarget =
  | { kind: 'REST'; stageNumber: null }
  | { kind: 'STAGE'; stageNumber: number }
  | { kind: 'RECOVERY'; stageNumber: null };

export interface MeasurementSyncPayload {
  target: MeasurementSyncTarget;
  lactateValueX100: number | null;
  lactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  heartRate: number | null;
  measuredAt: string;
}

export interface TestMeasurementSyncOperation {
  operationId: string;
  testId: string;
  entityId: string;
  expectedVersion: number;
  occurredAt: string;
  operationType: typeof TEST_MEASUREMENT_SYNC_OPERATION;
  schemaVersion: typeof TEST_MEASUREMENT_SYNC_SCHEMA_VERSION;
  payload: MeasurementSyncPayload;
}

export type TestMeasurementSyncResult =
  | { status: 'APPLIED'; newVersion: number }
  | { status: 'CONFLICT'; serverVersion: number; serverState: unknown };

export interface TestMeasurementSyncActor {
  userId: string;
  role: string;
}

function requireActor(actor: TestMeasurementSyncActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may synchronize test measurements');
  }
}

function measurementEntityId(target: MeasurementSyncTarget): string {
  return target.kind === 'STAGE' ? `STAGE:${target.stageNumber}` : target.kind;
}

function requireOperation(operation: TestMeasurementSyncOperation): void {
  if (!operation.operationId.trim()) throw new Error('Operation ID must not be empty');
  if (!operation.testId.trim()) throw new Error('Test ID must not be empty');
  if (
    operation.operationType !== TEST_MEASUREMENT_SYNC_OPERATION
    || operation.schemaVersion !== TEST_MEASUREMENT_SYNC_SCHEMA_VERSION
  ) {
    throw new Error('Unsupported measurement sync operation');
  }
  if (
    !Number.isInteger(operation.expectedVersion)
    || operation.expectedVersion < 0
  ) {
    throw new Error('Expected version must be a non-negative integer');
  }
  if (!Number.isFinite(Date.parse(operation.occurredAt))) {
    throw new Error('Operation time must be a valid ISO-8601 timestamp');
  }

  const { payload } = operation;
  const targetIsValid = (
    (
      (payload.target.kind === 'REST' || payload.target.kind === 'RECOVERY')
      && payload.target.stageNumber === null
    )
    || (
      payload.target.kind === 'STAGE'
      && Number.isInteger(payload.target.stageNumber)
      && payload.target.stageNumber >= 1
      && payload.target.stageNumber <= 12
    )
  );
  if (!targetIsValid || operation.entityId !== measurementEntityId(payload.target)) {
    throw new Error('Measurement target does not match entity ID');
  }
  if (
    payload.lactateValueX100 !== null
    && (
      !Number.isInteger(payload.lactateValueX100)
      || payload.lactateValueX100 < 50
      || payload.lactateValueX100 > 3_000
    )
  ) {
    throw new Error('Lactate value is outside the supported range');
  }
  if (
    payload.lactateQualifier !== null
    && payload.lactateQualifier !== 'EXACT'
    && payload.lactateQualifier !== 'LESS_THAN'
    && payload.lactateQualifier !== 'GREATER_THAN'
  ) {
    throw new Error('Lactate qualifier is invalid');
  }
  if (
    (payload.lactateValueX100 === null) !== (payload.lactateQualifier === null)
  ) {
    throw new Error('Lactate value and qualifier must both be present or absent');
  }
  if (
    payload.heartRate !== null
    && (
      !Number.isInteger(payload.heartRate)
      || payload.heartRate < 20
      || payload.heartRate > 250
    )
  ) {
    throw new Error('Heart rate is outside the supported range');
  }
  if (payload.lactateValueX100 === null && payload.heartRate === null) {
    throw new Error('At least one measurement value is required');
  }
  if (!Number.isFinite(Date.parse(payload.measuredAt))) {
    throw new Error('Measurement time must be a valid ISO-8601 timestamp');
  }
}

function parseStoredResult(value: string | null): TestMeasurementSyncResult {
  if (!value) throw new Error('Stored sync result is missing');
  return JSON.parse(value) as TestMeasurementSyncResult;
}

function sameStoredOperation(
  stored: typeof syncOperations.$inferSelect,
  operation: TestMeasurementSyncOperation,
  payloadJson: string,
): boolean {
  return (
    stored.testId === operation.testId
    && stored.entityId === operation.entityId
    && stored.expectedVersion === operation.expectedVersion
    && stored.occurredAt === operation.occurredAt
    && stored.operationType === operation.operationType
    && stored.schemaVersion === operation.schemaVersion
    && stored.payloadJson === payloadJson
  );
}

export async function syncTestMeasurement(
  db: Database,
  tenantId: string,
  actor: TestMeasurementSyncActor,
  operation: TestMeasurementSyncOperation,
): Promise<TestMeasurementSyncResult> {
  requireActor(actor);
  requireOperation(operation);

  const timerPlan = await getTestTimerPlan(
    db,
    tenantId,
    actor,
    operation.testId,
  );
  const payloadJson = JSON.stringify(operation.payload);

  return db.transaction(async (tx) => {
    const [previousOperation] = await tx
      .select()
      .from(syncOperations)
      .where(and(
        eq(syncOperations.tenantId, tenantId),
        eq(syncOperations.operationId, operation.operationId),
      ))
      .limit(1);
    if (previousOperation) {
      if (!sameStoredOperation(previousOperation, operation, payloadJson)) {
        throw new Error('Operation ID was reused with different content');
      }
      return parseStoredResult(previousOperation.resultJson);
    }

    const [test] = await tx
      .select()
      .from(tests)
      .where(and(
        eq(tests.id, operation.testId),
        eq(tests.tenantId, tenantId),
      ))
      .limit(1);
    if (!test) throw new Error('Test not found for measurement synchronization');
    if (test.conductingTrainerUserId !== actor.userId) {
      throw new Error('Only the conducting trainer may synchronize test measurements');
    }
    if (test.status !== 'IN_PROGRESS' && test.status !== 'DATA_REVIEW') {
      throw new Error(`Measurements cannot synchronize while test is ${test.status}`);
    }

    const now = new Date().toISOString();
    let before: unknown = null;
    let after: unknown;
    let serverVersion = 0;
    let entityDatabaseId: string;

    if (operation.payload.target.kind === 'REST') {
      const [existing] = await tx
        .select()
        .from(restMeasurements)
        .where(and(
          eq(restMeasurements.tenantId, tenantId),
          eq(restMeasurements.testId, operation.testId),
        ))
        .limit(1);
      serverVersion = existing?.currentVersion ?? 0;
      before = existing ?? null;
      if (serverVersion === operation.expectedVersion) {
        if (existing) {
          const [updated] = await tx.update(restMeasurements).set({
            heartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            measuredAt: operation.payload.measuredAt,
            currentVersion: serverVersion + 1,
            updatedAt: now,
          }).where(and(
            eq(restMeasurements.id, existing.id),
            eq(restMeasurements.tenantId, tenantId),
            eq(restMeasurements.currentVersion, serverVersion),
          )).returning();
          if (!updated) throw new Error('Rest measurement changed concurrently');
          after = updated;
          entityDatabaseId = updated.id;
        } else {
          const [inserted] = await tx.insert(restMeasurements).values({
            id: crypto.randomUUID(),
            tenantId,
            testId: operation.testId,
            heartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            measuredAt: operation.payload.measuredAt,
            currentVersion: 1,
            createdAt: now,
            updatedAt: now,
          }).returning();
          if (!inserted) throw new Error('Rest measurement was not created');
          after = inserted;
          entityDatabaseId = inserted.id;
        }
      } else {
        after = existing ?? null;
        entityDatabaseId = existing?.id ?? operation.entityId;
      }
    } else if (operation.payload.target.kind === 'RECOVERY') {
      const [existing] = await tx
        .select()
        .from(recoveryMeasurements)
        .where(and(
          eq(recoveryMeasurements.tenantId, tenantId),
          eq(recoveryMeasurements.testId, operation.testId),
        ))
        .limit(1);
      serverVersion = existing?.currentVersion ?? 0;
      before = existing ?? null;
      if (serverVersion === operation.expectedVersion) {
        if (existing) {
          const [updated] = await tx.update(recoveryMeasurements).set({
            heartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            measuredAt: operation.payload.measuredAt,
            currentVersion: serverVersion + 1,
            updatedAt: now,
          }).where(and(
            eq(recoveryMeasurements.id, existing.id),
            eq(recoveryMeasurements.tenantId, tenantId),
            eq(recoveryMeasurements.currentVersion, serverVersion),
          )).returning();
          if (!updated) throw new Error('Recovery measurement changed concurrently');
          after = updated;
          entityDatabaseId = updated.id;
        } else {
          const [inserted] = await tx.insert(recoveryMeasurements).values({
            id: crypto.randomUUID(),
            tenantId,
            testId: operation.testId,
            targetOffsetSeconds: 300,
            heartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            measuredAt: operation.payload.measuredAt,
            currentVersion: 1,
            createdAt: now,
            updatedAt: now,
          }).returning();
          if (!inserted) throw new Error('Recovery measurement was not created');
          after = inserted;
          entityDatabaseId = inserted.id;
        }
      } else {
        after = existing ?? null;
        entityDatabaseId = existing?.id ?? operation.entityId;
      }
    } else {
      const stageNumber = operation.payload.target.stageNumber;
      const stagePhase = timerPlan.phases.find(
        (phase) => phase.kind === 'STAGE' && phase.stageNumber === stageNumber,
      );
      if (!stagePhase) throw new Error('Stage is not part of the immutable test plan');
      const [existing] = await tx
        .select()
        .from(testStages)
        .where(and(
          eq(testStages.tenantId, tenantId),
          eq(testStages.testId, operation.testId),
          eq(testStages.stageNumber, stageNumber),
        ))
        .limit(1);
      serverVersion = existing?.currentVersion ?? 0;
      before = existing ?? null;
      if (serverVersion === operation.expectedVersion) {
        if (existing) {
          const [updated] = await tx.update(testStages).set({
            endHeartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            lactateMeasuredAt: operation.payload.measuredAt,
            currentVersion: serverVersion + 1,
            updatedAt: now,
          }).where(and(
            eq(testStages.id, existing.id),
            eq(testStages.tenantId, tenantId),
            eq(testStages.currentVersion, serverVersion),
          )).returning();
          if (!updated) throw new Error('Stage measurement changed concurrently');
          after = updated;
          entityDatabaseId = updated.id;
        } else {
          const [inserted] = await tx.insert(testStages).values({
            id: crypto.randomUUID(),
            tenantId,
            testId: operation.testId,
            stageNumber,
            targetWatts: stagePhase.targetWatts!,
            plannedSeconds: stagePhase.durationSeconds,
            endHeartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            lactateMeasuredAt: operation.payload.measuredAt,
            currentVersion: 1,
            createdAt: now,
            updatedAt: now,
          }).returning();
          if (!inserted) throw new Error('Stage measurement was not created');
          after = inserted;
          entityDatabaseId = inserted.id;
        }
      } else {
        after = existing ?? null;
        entityDatabaseId = existing?.id ?? operation.entityId;
      }
    }

    if (serverVersion !== operation.expectedVersion) {
      const result: TestMeasurementSyncResult = {
        status: 'CONFLICT',
        serverVersion,
        serverState: after,
      };
      await tx.insert(syncOperations).values({
        id: crypto.randomUUID(),
        tenantId,
        operationId: operation.operationId,
        testId: operation.testId,
        entityId: operation.entityId,
        expectedVersion: operation.expectedVersion,
        occurredAt: operation.occurredAt,
        operationType: operation.operationType,
        schemaVersion: operation.schemaVersion,
        payloadJson,
        status: 'CONFLICT',
        resultJson: JSON.stringify(result),
        createdAt: now,
        updatedAt: now,
      });
      return result;
    }

    const result: TestMeasurementSyncResult = {
      status: 'APPLIED',
      newVersion: serverVersion + 1,
    };
    await tx.insert(syncOperations).values({
      id: crypto.randomUUID(),
      tenantId,
      operationId: operation.operationId,
      testId: operation.testId,
      entityId: operation.entityId,
      expectedVersion: operation.expectedVersion,
      occurredAt: operation.occurredAt,
      operationType: operation.operationType,
      schemaVersion: operation.schemaVersion,
      payloadJson,
      status: 'APPLIED',
      resultJson: JSON.stringify(result),
      appliedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId,
      occurredAt: operation.occurredAt,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'test.measurement.synced',
      entityType: `test_measurement.${operation.payload.target.kind.toLowerCase()}`,
      entityId: entityDatabaseId,
      source: 'OFFLINE_SYNC',
      correlationId: operation.operationId,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
      createdAt: now,
      updatedAt: now,
    });
    return result;
  });
}
