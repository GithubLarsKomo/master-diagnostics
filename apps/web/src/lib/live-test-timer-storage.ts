'use client';

import type { LiveTestTimerState } from '@masters/sync';
import { restoreLiveTestTimerState } from '@masters/sync';
import Dexie, { type Table } from 'dexie';

class MastersDiagnosticsBrowserDatabase extends Dexie {
  liveTestTimers!: Table<LiveTestTimerState, string>;

  constructor() {
    super('masters-diagnostics');
    this.version(1).stores({
      liveTestTimers: 'testId, updatedAtMs',
    });
  }
}

let browserDatabase: MastersDiagnosticsBrowserDatabase | null = null;

function getBrowserDatabase(): MastersDiagnosticsBrowserDatabase {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable');
  }
  browserDatabase ??= new MastersDiagnosticsBrowserDatabase();
  return browserDatabase;
}

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
