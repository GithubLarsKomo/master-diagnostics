'use client';

import type { LiveTestMeasurementsState } from '@masters/sync';
import { restoreLiveTestMeasurementsState } from '@masters/sync';
import { getBrowserDatabase } from './browser-database';

export async function loadLiveTestMeasurementsState(
  testId: string,
  startedAt: string,
  stageCount: number,
): Promise<LiveTestMeasurementsState | null> {
  const table = getBrowserDatabase().liveTestMeasurements;
  const candidate = await table.get(testId);
  const restored = restoreLiveTestMeasurementsState(
    candidate,
    testId,
    startedAt,
    stageCount,
  );
  if (candidate && !restored) await table.delete(testId);
  return restored;
}

export function saveLiveTestMeasurementsState(
  state: LiveTestMeasurementsState,
): Promise<string> {
  return getBrowserDatabase().liveTestMeasurements.put(state);
}
