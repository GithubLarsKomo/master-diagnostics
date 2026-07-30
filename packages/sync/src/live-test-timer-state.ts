export interface LiveTestTimerState {
  schemaVersion: 1;
  testId: string;
  startedAt: string;
  pausedAtMs: number | null;
  accumulatedPauseMs: number;
  updatedAtMs: number;
}

function requireTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite timestamp`);
  }
}

function requireIdentity(testId: string, startedAt: string): void {
  if (!testId.trim()) throw new Error('Test ID must not be empty');
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new Error('Test start must be a valid ISO-8601 timestamp');
  }
}

export function createLiveTestTimerState(
  testId: string,
  startedAt: string,
  nowMs: number,
): LiveTestTimerState {
  requireIdentity(testId, startedAt);
  requireTimestamp(nowMs, 'Current time');
  return {
    schemaVersion: 1,
    testId,
    startedAt,
    pausedAtMs: null,
    accumulatedPauseMs: 0,
    updatedAtMs: nowMs,
  };
}

export function restoreLiveTestTimerState(
  candidate: unknown,
  expectedTestId: string,
  expectedStartedAt: string,
): LiveTestTimerState | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const state = candidate as Partial<LiveTestTimerState>;
  if (
    state.schemaVersion !== 1
    || state.testId !== expectedTestId
    || state.startedAt !== expectedStartedAt
    || typeof state.accumulatedPauseMs !== 'number'
    || !Number.isFinite(state.accumulatedPauseMs)
    || state.accumulatedPauseMs < 0
    || typeof state.updatedAtMs !== 'number'
    || !Number.isFinite(state.updatedAtMs)
    || state.updatedAtMs < 0
    || (
      state.pausedAtMs !== null
      && (
        typeof state.pausedAtMs !== 'number'
        || !Number.isFinite(state.pausedAtMs)
        || state.pausedAtMs < 0
      )
    )
  ) {
    return null;
  }
  return state as LiveTestTimerState;
}

export function pauseLiveTestTimerState(
  state: LiveTestTimerState,
  pausedAtMs: number,
): LiveTestTimerState {
  requireTimestamp(pausedAtMs, 'Pause time');
  if (state.pausedAtMs !== null) throw new Error('Timer is already paused');
  return { ...state, pausedAtMs, updatedAtMs: pausedAtMs };
}

export function resumeLiveTestTimerState(
  state: LiveTestTimerState,
  resumedAtMs: number,
): LiveTestTimerState {
  requireTimestamp(resumedAtMs, 'Resume time');
  if (state.pausedAtMs === null) throw new Error('Timer is not paused');
  if (resumedAtMs < state.pausedAtMs) {
    throw new Error('Resume time may not be before pause time');
  }
  return {
    ...state,
    pausedAtMs: null,
    accumulatedPauseMs: state.accumulatedPauseMs + resumedAtMs - state.pausedAtMs,
    updatedAtMs: resumedAtMs,
  };
}
