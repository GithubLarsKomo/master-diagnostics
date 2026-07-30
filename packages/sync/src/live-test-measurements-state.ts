export type LactateQualifier = 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';

export type LiveTestMeasurementTarget =
  | { kind: 'REST'; stageNumber: null }
  | { kind: 'STAGE'; stageNumber: number }
  | { kind: 'RECOVERY'; stageNumber: null };

export interface LiveTestMeasurement {
  target: LiveTestMeasurementTarget;
  lactateValueX100: number | null;
  lactateQualifier: LactateQualifier | null;
  heartRate: number | null;
  measuredAt: string;
  updatedAtMs: number;
}

export interface LiveTestMeasurementsState {
  schemaVersion: 1;
  testId: string;
  startedAt: string;
  stageCount: number;
  measurements: Record<string, LiveTestMeasurement>;
  updatedAtMs: number;
}

function requireTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite timestamp`);
  }
}

function requireIdentity(testId: string, startedAt: string, stageCount: number): void {
  if (!testId.trim()) throw new Error('Test ID must not be empty');
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new Error('Test start must be a valid ISO-8601 timestamp');
  }
  if (!Number.isInteger(stageCount) || stageCount < 1 || stageCount > 12) {
    throw new Error('Stage count must be an integer between 1 and 12');
  }
}

export function liveTestMeasurementKey(target: LiveTestMeasurementTarget): string {
  if (target.kind !== 'STAGE') return target.kind;
  return `STAGE:${target.stageNumber}`;
}

function isValidTarget(
  candidate: unknown,
  stageCount: number,
): candidate is LiveTestMeasurementTarget {
  if (!candidate || typeof candidate !== 'object') return false;
  const target = candidate as Partial<LiveTestMeasurementTarget>;
  if (
    (target.kind === 'REST' || target.kind === 'RECOVERY')
    && target.stageNumber === null
  ) {
    return true;
  }
  return (
    target.kind === 'STAGE'
    && typeof target.stageNumber === 'number'
    && Number.isInteger(target.stageNumber)
    && target.stageNumber >= 1
    && target.stageNumber <= stageCount
  );
}

function isValidMeasurement(
  candidate: unknown,
  expectedKey: string,
  stageCount: number,
): candidate is LiveTestMeasurement {
  if (!candidate || typeof candidate !== 'object') return false;
  const measurement = candidate as Partial<LiveTestMeasurement>;
  if (
    !isValidTarget(measurement.target, stageCount)
    || liveTestMeasurementKey(measurement.target) !== expectedKey
    || (
      measurement.lactateValueX100 !== null
      && (
        typeof measurement.lactateValueX100 !== 'number'
        || !Number.isInteger(measurement.lactateValueX100)
        || measurement.lactateValueX100 < 50
        || measurement.lactateValueX100 > 3_000
      )
    )
    || (
      measurement.lactateQualifier !== null
      && measurement.lactateQualifier !== 'EXACT'
      && measurement.lactateQualifier !== 'LESS_THAN'
      && measurement.lactateQualifier !== 'GREATER_THAN'
    )
    || (
      measurement.heartRate !== null
      && (
        typeof measurement.heartRate !== 'number'
        || !Number.isInteger(measurement.heartRate)
        || measurement.heartRate < 20
        || measurement.heartRate > 250
      )
    )
    || typeof measurement.measuredAt !== 'string'
    || !Number.isFinite(Date.parse(measurement.measuredAt))
    || typeof measurement.updatedAtMs !== 'number'
    || !Number.isFinite(measurement.updatedAtMs)
    || measurement.updatedAtMs < 0
  ) {
    return false;
  }
  return (
    (measurement.lactateValueX100 === null && measurement.lactateQualifier === null)
    || (
      measurement.lactateValueX100 !== null
      && measurement.lactateQualifier !== null
    )
  ) && (measurement.lactateValueX100 !== null || measurement.heartRate !== null);
}

export function createLiveTestMeasurementsState(
  testId: string,
  startedAt: string,
  stageCount: number,
  nowMs: number,
): LiveTestMeasurementsState {
  requireIdentity(testId, startedAt, stageCount);
  requireTimestamp(nowMs, 'Current time');
  return {
    schemaVersion: 1,
    testId,
    startedAt,
    stageCount,
    measurements: {},
    updatedAtMs: nowMs,
  };
}

export function restoreLiveTestMeasurementsState(
  candidate: unknown,
  expectedTestId: string,
  expectedStartedAt: string,
  expectedStageCount: number,
): LiveTestMeasurementsState | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const state = candidate as Partial<LiveTestMeasurementsState>;
  if (
    state.schemaVersion !== 1
    || state.testId !== expectedTestId
    || state.startedAt !== expectedStartedAt
    || state.stageCount !== expectedStageCount
    || !state.measurements
    || typeof state.measurements !== 'object'
    || Array.isArray(state.measurements)
    || typeof state.updatedAtMs !== 'number'
    || !Number.isFinite(state.updatedAtMs)
    || state.updatedAtMs < 0
    || Object.entries(state.measurements).some(
      ([key, measurement]) => !isValidMeasurement(measurement, key, expectedStageCount),
    )
  ) {
    return null;
  }
  return state as LiveTestMeasurementsState;
}

export function upsertLiveTestMeasurement(
  state: LiveTestMeasurementsState,
  measurement: LiveTestMeasurement,
): LiveTestMeasurementsState {
  if (
    !isValidMeasurement(
      measurement,
      liveTestMeasurementKey(measurement.target),
      state.stageCount,
    )
  ) {
    throw new Error('Measurement is invalid');
  }
  if (measurement.updatedAtMs < state.updatedAtMs) {
    throw new Error('Measurement update may not move backwards');
  }
  return {
    ...state,
    measurements: {
      ...state.measurements,
      [liveTestMeasurementKey(measurement.target)]: measurement,
    },
    updatedAtMs: measurement.updatedAtMs,
  };
}
