'use client';

import type {
  LiveTestMeasurementsState,
  LiveTestTimerState,
} from '@masters/sync';
import Dexie, { type Table } from 'dexie';

class MastersDiagnosticsBrowserDatabase extends Dexie {
  liveTestTimers!: Table<LiveTestTimerState, string>;
  liveTestMeasurements!: Table<LiveTestMeasurementsState, string>;

  constructor() {
    super('masters-diagnostics');
    this.version(1).stores({
      liveTestTimers: 'testId, updatedAtMs',
    });
    this.version(2).stores({
      liveTestTimers: 'testId, updatedAtMs',
      liveTestMeasurements: 'testId, updatedAtMs',
    });
  }
}

let browserDatabase: MastersDiagnosticsBrowserDatabase | null = null;

export function getBrowserDatabase(): MastersDiagnosticsBrowserDatabase {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable');
  }
  browserDatabase ??= new MastersDiagnosticsBrowserDatabase();
  return browserDatabase;
}
