import { describe, expect, it } from 'vitest';
import { createLiveTestMeasurementSyncOperation } from '../src/live-test-measurement-sync';

describe('live test measurement sync operation', () => {
  it('creates a stable server envelope without browser-only metadata', () => {
    expect(createLiveTestMeasurementSyncOperation(
      'test-a',
      {
        target: { kind: 'STAGE', stageNumber: 2 },
        lactateValueX100: 240,
        lactateQualifier: 'LESS_THAN',
        heartRate: 138,
        measuredAt: '2026-07-30T09:10:00.000Z',
        updatedAtMs: 1_000,
      },
      'operation-a',
      3,
      2_000,
    )).toEqual({
      operationId: 'operation-a',
      testId: 'test-a',
      entityId: 'STAGE:2',
      entityKey: 'test-a:STAGE:2',
      expectedVersion: 3,
      occurredAt: '1970-01-01T00:00:02.000Z',
      operationType: 'TEST_MEASUREMENT_UPSERT',
      schemaVersion: '1',
      payload: {
        target: { kind: 'STAGE', stageNumber: 2 },
        lactateValueX100: 240,
        lactateQualifier: 'LESS_THAN',
        heartRate: 138,
        measuredAt: '2026-07-30T09:10:00.000Z',
      },
      status: 'PENDING',
      result: null,
      updatedAtMs: 2_000,
    });
  });
});
