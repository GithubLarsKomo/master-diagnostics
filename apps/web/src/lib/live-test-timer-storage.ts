'use client';

import type { LiveTestTimerState } from '@masters/sync';
import { restoreLiveTestTimerState } from '@masters/sync';
import { getBrowserDatabase } from './browser-database';

export async function loadLiveTestTimerState(
  testId: string,
  startedAt: string,
): Promise<LiveTestTimerState | null> {
  const table = getBrowserDatabase().liveTestTimers;
  const candidate = await table.get(testId);
  const restored = restoreLiveTestTimerState(candidate, testId, startedAt);
  if (candidate && !restored) await table.delete(testId);
  return restored;
}

export function saveLiveTestTimerState(state: LiveTestTimerState): Promise<string> {
  return getBrowserDatabase().liveTestTimers.put(state);
}
