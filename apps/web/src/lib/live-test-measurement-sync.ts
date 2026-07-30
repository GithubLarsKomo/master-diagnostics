'use client';

import {
  createLiveTestMeasurementSyncOperation,
  type LiveTestMeasurement,
  type LiveTestMeasurementSyncOperation,
} from '@masters/sync';
import { getBrowserDatabase } from './browser-database';

export type LiveTestMeasurementSyncStatus =
  | { status: 'SYNCED' }
  | { status: 'PENDING' }
  | { status: 'CONFLICT'; serverVersion: number; serverState: unknown };

async function latestOperation(
  testId: string,
  entityId: string,
): Promise<LiveTestMeasurementSyncOperation | null> {
  const operations = await getBrowserDatabase()
    .liveTestMeasurementSyncOperations
    .where('entityKey')
    .equals(`${testId}:${entityId}`)
    .toArray();
  return operations.sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  )[0] ?? null;
}

function nextExpectedVersion(
  previous: LiveTestMeasurementSyncOperation | null,
): number {
  if (!previous) return 0;
  if (previous.status === 'CONFLICT') {
    throw new Error('Der Serverkonflikt muss vor einer weiteren Änderung aufgelöst werden.');
  }
  if (previous.status === 'PENDING') return previous.expectedVersion + 1;
  if (previous.result?.status !== 'APPLIED') {
    throw new Error('Der letzte Synchronisationsstand ist unvollständig.');
  }
  return previous.result.newVersion;
}

export async function enqueueLiveTestMeasurementSync(
  testId: string,
  measurement: LiveTestMeasurement,
): Promise<LiveTestMeasurementSyncOperation> {
  const entityId = measurement.target.kind === 'STAGE'
    ? `STAGE:${measurement.target.stageNumber}`
    : measurement.target.kind;
  const previous = await latestOperation(testId, entityId);
  const timestamp = Math.max(
    Date.now(),
    measurement.updatedAtMs,
    (previous?.updatedAtMs ?? 0) + 1,
  );
  const operation = createLiveTestMeasurementSyncOperation(
    testId,
    measurement,
    crypto.randomUUID(),
    nextExpectedVersion(previous),
    timestamp,
  );
  await getBrowserDatabase().liveTestMeasurementSyncOperations.put(operation);
  return operation;
}

function requestBody(operation: LiveTestMeasurementSyncOperation) {
  return {
    operationId: operation.operationId,
    testId: operation.testId,
    entityId: operation.entityId,
    expectedVersion: operation.expectedVersion,
    occurredAt: operation.occurredAt,
    operationType: operation.operationType,
    schemaVersion: operation.schemaVersion,
    payload: operation.payload,
  };
}

export async function synchronizePendingLiveTestMeasurements(
  testId: string,
): Promise<LiveTestMeasurementSyncStatus> {
  const table = getBrowserDatabase().liveTestMeasurementSyncOperations;
  const operations = await table.where('testId').equals(testId).toArray();
  const existingConflict = operations
    .filter((operation) => operation.status === 'CONFLICT')
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  if (existingConflict?.result?.status === 'CONFLICT') {
    return {
      status: 'CONFLICT',
      serverVersion: existingConflict.result.serverVersion,
      serverState: existingConflict.result.serverState,
    };
  }
  const pending = operations
    .filter((operation) => operation.status === 'PENDING')
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs);

  for (const operation of pending) {
    try {
      const response = await fetch(
        `/api/tests/${encodeURIComponent(testId)}/measurements/sync`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody(operation)),
        },
      );
      if (!response.ok) return { status: 'PENDING' };
      const result = await response.json() as
        | { status: 'APPLIED'; newVersion: number }
        | { status: 'CONFLICT'; serverVersion: number; serverState: unknown };
      if (result.status === 'CONFLICT') {
        await table.put({
          ...operation,
          status: 'CONFLICT',
          result,
          updatedAtMs: Date.now(),
        });
        return {
          status: 'CONFLICT',
          serverVersion: result.serverVersion,
          serverState: result.serverState,
        };
      }
      await table.put({
        ...operation,
        status: 'APPLIED',
        result,
        updatedAtMs: Date.now(),
      });
    } catch {
      return { status: 'PENDING' };
    }
  }
  return { status: 'SYNCED' };
}
