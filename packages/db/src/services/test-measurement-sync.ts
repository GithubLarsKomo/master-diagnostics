import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  recoveryMeasurements,
  restMeasurements,
  syncOperations,
  testLocks,
  testStages,
  tests,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import { hashTestLockToken } from './test-locks';
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

export type TestMeasurementSyncActor = AuditActorContext;

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

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sameJsonDocument(left: string, right: string): boolean {
  try {
    return canonicalJson(JSON.parse(left)) === canonicalJson(JSON.parse(right));
  } catch {
    return false;
  }
}

function sameTimestamp(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
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
    && sameTimestamp(stored.occurredAt, operation.occurredAt)
    && stored.operationType === operation.operationType
    && stored.schemaVersion === operation.schemaVersion
    && sameJsonDocument(stored.payloadJson, payloadJson)
  );
}

export async function syncTestMeasurement(
  db: Database,
  tenantId: string,
  actor: TestMeasurementSyncActor,
  operation: TestMeasurementSyncOperation,
  lockToken: string,
): Promise<TestMeasurementSyncResult> {
  requireActor(actor);
  requireOperation(operation);

  const timerPlan = await getTestTimerPlan(
    db,
    tenantId,
    actor,
    operation.testId,
  );
  if (!timerPlan) throw new Error('Test timer context not found');

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
    const [lock] = await tx.select().from(testLocks).where(and(
      eq(testLocks.tenantId, tenantId),
      eq(testLocks.testId, operation.testId),
      eq(testLocks.ownerUserId, actor.userId),
      eq(testLocks.tokenHash, hashTestLockToken(lockToken)),
    )).limit(1);
    if (!lock || lock.expiresAt <= new Date().toISOString()) {
      throw new Error('An active test lock is required for measurement synchronization');
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
          )).returning();
          after = updated;
          entityDatabaseId = existing.id;
        } else {
          entityDatabaseId = crypto.randomUUID();
          const [inserted] = await tx.insert(restMeasurements).values({
            id: entityDatabaseId,
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
          after = inserted;
        }
      } else {
        after = existing;
        entityDatabaseId = existing?.id ?? operation.entityId;
      }
    } else if (operation.payload.target.kind === 'STAGE') {
      const stageNumber = operation.payload.target.stageNumber;
      const [existing] = await tx
        .select()
        .from(testStages)
        .where(and(
          eq(testStages.tenantId, tenantId),
          eq(testStages.testId, operation.testId),
          eq(testStages.stageNumber, stageNumber),
        ))
        .limit(1);
      if (!existing) throw new Error('Test stage not found for measurement synchronization');
      serverVersion = existing.measurementVersion;
      before = existing;
      entityDatabaseId = existing.id;
      if (serverVersion === operation.expectedVersion) {
        const [updated] = await tx.update(testStages).set({
          heartRate: operation.payload.heartRate,
          lactateValueX100: operation.payload.lactateValueX100,
          lactateQualifier: operation.payload.lactateQualifier,
          measurementVersion: serverVersion + 1,
          updatedAt: now,
        }).where(and(
          eq(testStages.id, existing.id),
          eq(testStages.tenantId, tenantId),
        )).returning();
        after = updated;
      } else {
        after = existing;
      }
    } else {
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
          )).returning();
          after = updated;
          entityDatabaseId = existing.id;
        } else {
          entityDatabaseId = crypto.randomUUID();
          const [inserted] = await tx.insert(recoveryMeasurements).values({
            id: entityDatabaseId,
            tenantId,
            testId: operation.testId,
            secondsAfterLastStage: timerPlan.recoverySeconds,
            heartRate: operation.payload.heartRate,
            lactateValueX100: operation.payload.lactateValueX100,
            lactateQualifier: operation.payload.lactateQualifier,
            measuredAt: operation.payload.measuredAt,
            currentVersion: 1,
            createdAt: now,
            updatedAt: now,
          }).returning();
          after = inserted;
        }
      } else {
        after = existing;
        entityDatabaseId = existing?.id ?? operation.entityId;
      }
    }

    const result: TestMeasurementSyncResult = serverVersion === operation.expectedVersion
      ? { status: 'APPLIED', newVersion: serverVersion + 1 }
      : { status: 'CONFLICT', serverVersion, serverState: after };

    await tx.insert(syncOperations).values({
      id: crypto.randomUUID(),
      tenantId,
      operationId: operation.operationId,
      testId: operation.testId,
      entityId: operation.entityId,
      expectedVersion: operation.expectedVersion,
      operationType: operation.operationType,
      schemaVersion: operation.schemaVersion,
      occurredAt: operation.occurredAt,
      payloadJson,
      resultJson: JSON.stringify(result),
      createdAt: now,
      updatedAt: now,
    });

    await appendAuditEvent(tx, {
      tenantId,
      actor,
      action: 'TEST_MEASUREMENT_SYNCED',
      entityType: operation.payload.target.kind === 'STAGE' ? 'TEST_STAGE' : 'TEST_MEASUREMENT',
      entityId: entityDatabaseId,
      operationId: operation.operationId,
      before,
      after: { result, value: after },
      createdAt: now,
    });

    return result;
  });
}
