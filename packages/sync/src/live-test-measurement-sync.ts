import {
  liveTestMeasurementKey,
  type LiveTestMeasurement,
} from './live-test-measurements-state';

export type LiveTestMeasurementSyncResult =
  | { status: 'APPLIED'; newVersion: number }
  | { status: 'CONFLICT'; serverVersion: number; serverState: unknown };

export interface LiveTestMeasurementSyncOperation {
  operationId: string;
  testId: string;
  entityId: string;
  entityKey: string;
  expectedVersion: number;
  occurredAt: string;
  operationType: 'TEST_MEASUREMENT_UPSERT';
  schemaVersion: '1';
  payload: Omit<LiveTestMeasurement, 'updatedAtMs'>;
  status: 'PENDING' | 'APPLIED' | 'CONFLICT';
  result: LiveTestMeasurementSyncResult | null;
  updatedAtMs: number;
}

export function createLiveTestMeasurementSyncOperation(
  testId: string,
  measurement: LiveTestMeasurement,
  operationId: string,
  expectedVersion: number,
  nowMs: number,
): LiveTestMeasurementSyncOperation {
  if (!testId.trim()) throw new Error('Test ID must not be empty');
  if (!operationId.trim()) throw new Error('Operation ID must not be empty');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new Error('Expected version must be a non-negative integer');
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Current time must be a non-negative finite timestamp');
  }
  const entityId = liveTestMeasurementKey(measurement.target);
  return {
    operationId,
    testId,
    entityId,
    entityKey: `${testId}:${entityId}`,
    expectedVersion,
    occurredAt: new Date(nowMs).toISOString(),
    operationType: 'TEST_MEASUREMENT_UPSERT',
    schemaVersion: '1',
    payload: {
      target: measurement.target,
      lactateValueX100: measurement.lactateValueX100,
      lactateQualifier: measurement.lactateQualifier,
      heartRate: measurement.heartRate,
      measuredAt: measurement.measuredAt,
    },
    status: 'PENDING',
    result: null,
    updatedAtMs: nowMs,
  };
}
