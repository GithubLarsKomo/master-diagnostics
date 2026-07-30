import { describe, expect, it } from 'vitest';
import {
  createLiveTestTimerState,
  pauseLiveTestTimerState,
  restoreLiveTestTimerState,
  resumeLiveTestTimerState,
} from '../src/live-test-timer-state';

const startedAt = '2026-07-30T08:00:00.000Z';

describe('live test timer state', () => {
  it('preserves a paused timer across serialization and resumes without counting the pause', () => {
    const initial = createLiveTestTimerState('test-a', startedAt, 1_000);
    const paused = pauseLiveTestTimerState(initial, 5_000);
    const restored = restoreLiveTestTimerState(
      JSON.parse(JSON.stringify(paused)),
      'test-a',
      startedAt,
    );

    expect(restored).toEqual(paused);
    expect(resumeLiveTestTimerState(restored!, 9_500)).toEqual({
      ...initial,
      accumulatedPauseMs: 4_500,
      updatedAtMs: 9_500,
    });
  });

  it('rejects stale, mismatched, and malformed persisted state', () => {
    const valid = createLiveTestTimerState('test-a', startedAt, 1_000);

    expect(restoreLiveTestTimerState(valid, 'test-b', startedAt)).toBeNull();
    expect(restoreLiveTestTimerState(valid, 'test-a', '2026-07-30T09:00:00.000Z')).toBeNull();
    expect(restoreLiveTestTimerState({ ...valid, schemaVersion: 2 }, 'test-a', startedAt)).toBeNull();
    expect(restoreLiveTestTimerState({ ...valid, accumulatedPauseMs: -1 }, 'test-a', startedAt)).toBeNull();
  });

  it('prevents invalid pause and resume transitions', () => {
    const initial = createLiveTestTimerState('test-a', startedAt, 1_000);
    const paused = pauseLiveTestTimerState(initial, 5_000);

    expect(() => pauseLiveTestTimerState(paused, 6_000)).toThrow('already paused');
    expect(() => resumeLiveTestTimerState(initial, 6_000)).toThrow('not paused');
    expect(() => resumeLiveTestTimerState(paused, 4_999)).toThrow('before pause');
  });
});
