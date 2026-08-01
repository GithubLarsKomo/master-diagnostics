import { describe, expect, it } from 'vitest';
import {
  createLiveTestMeasurementsState,
  getLiveTestMeasurementCaptureProgress,
  restoreLiveTestMeasurementsState,
  upsertLiveTestMeasurement,
} from '../src/live-test-measurements-state';

const startedAt = '2026-07-30T08:00:00.000Z';

describe('live test measurements state', () => {
  it('keeps one rest, stage, and recovery value per deterministic key', () => {
    const initial = createLiveTestMeasurementsState('test-a', startedAt, 7, 1_000);
    const rest = upsertLiveTestMeasurement(initial, {
      target: { kind: 'REST', stageNumber: null },
      lactateValueX100: 120,
      lactateQualifier: 'EXACT',
      heartRate: 52,
      measuredAt: '2026-07-30T08:01:00.000Z',
      updatedAtMs: 2_000,
    });
    const stage = upsertLiveTestMeasurement(rest, {
      target: { kind: 'STAGE', stageNumber: 1 },
      lactateValueX100: 180,
      lactateQualifier: 'LESS_THAN',
      heartRate: 128,
      measuredAt: '2026-07-30T08:10:00.000Z',
      updatedAtMs: 3_000,
    });
    const recovery = upsertLiveTestMeasurement(stage, {
      target: { kind: 'RECOVERY', stageNumber: null },
      lactateValueX100: null,
      lactateQualifier: null,
      heartRate: 88,
      measuredAt: '2026-07-30T08:50:00.000Z',
      updatedAtMs: 4_000,
    });

    expect(Object.keys(recovery.measurements)).toEqual([
      'REST',
      'STAGE:1',
      'RECOVERY',
    ]);
    expect(
      restoreLiveTestMeasurementsState(
        JSON.parse(JSON.stringify(recovery)),
        'test-a',
        startedAt,
        7,
      ),
    ).toEqual(recovery);
  });

  it('replaces a stage value instead of creating a duplicate', () => {
    const initial = createLiveTestMeasurementsState('test-a', startedAt, 7, 1_000);
    const first = upsertLiveTestMeasurement(initial, {
      target: { kind: 'STAGE', stageNumber: 3 },
      lactateValueX100: 240,
      lactateQualifier: 'EXACT',
      heartRate: null,
      measuredAt: '2026-07-30T08:20:00.000Z',
      updatedAtMs: 2_000,
    });
    const corrected = upsertLiveTestMeasurement(first, {
      ...first.measurements['STAGE:3']!,
      lactateValueX100: 260,
      updatedAtMs: 3_000,
    });

    expect(Object.keys(corrected.measurements)).toEqual(['STAGE:3']);
    expect(corrected.measurements['STAGE:3']?.lactateValueX100).toBe(260);
  });

  it('reports every required measurement target until capture is complete', () => {
    let state = createLiveTestMeasurementsState('test-a', startedAt, 2, 1_000);
    expect(getLiveTestMeasurementCaptureProgress(state)).toEqual({
      requiredCount: 4,
      capturedCount: 0,
      complete: false,
      missingTargets: [
        { kind: 'REST', stageNumber: null },
        { kind: 'STAGE', stageNumber: 1 },
        { kind: 'STAGE', stageNumber: 2 },
        { kind: 'RECOVERY', stageNumber: null },
      ],
    });

    const targets = [
      { kind: 'REST', stageNumber: null } as const,
      { kind: 'STAGE', stageNumber: 1 } as const,
      { kind: 'STAGE', stageNumber: 2 } as const,
      { kind: 'RECOVERY', stageNumber: null } as const,
    ];
    targets.forEach((target, index) => {
      state = upsertLiveTestMeasurement(state, {
        target,
        lactateValueX100: 120 + index * 20,
        lactateQualifier: 'EXACT',
        heartRate: 60 + index * 20,
        measuredAt: new Date(Date.parse(startedAt) + index * 60_000).toISOString(),
        updatedAtMs: 2_000 + index,
      });
    });

    expect(getLiveTestMeasurementCaptureProgress(state)).toEqual({
      requiredCount: 4,
      capturedCount: 4,
      complete: true,
      missingTargets: [],
    });
  });

  it('rejects mismatched identity, malformed values, and invalid stages', () => {
    const valid = createLiveTestMeasurementsState('test-a', startedAt, 7, 1_000);
    expect(
      restoreLiveTestMeasurementsState(valid, 'test-b', startedAt, 7),
    ).toBeNull();
    expect(
      restoreLiveTestMeasurementsState(valid, 'test-a', startedAt, 8),
    ).toBeNull();
    expect(() => upsertLiveTestMeasurement(valid, {
      target: { kind: 'STAGE', stageNumber: 8 },
      lactateValueX100: 200,
      lactateQualifier: 'EXACT',
      heartRate: null,
      measuredAt: startedAt,
      updatedAtMs: 2_000,
    })).toThrow('invalid');
    expect(() => upsertLiveTestMeasurement(valid, {
      target: { kind: 'REST', stageNumber: null },
      lactateValueX100: 3_001,
      lactateQualifier: 'EXACT',
      heartRate: null,
      measuredAt: startedAt,
      updatedAtMs: 2_000,
    })).toThrow('invalid');
  });
});
