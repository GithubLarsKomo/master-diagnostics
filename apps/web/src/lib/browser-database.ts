'use client';

import type {
  LiveTestMeasurementSyncOperation,
  LiveTestMeasurementsState,
  LiveTestTimerState,
} from '@masters/sync';
import Dexie, { type Table } from 'dexie';

class MastersDiagnosticsBrowserDatabase extends Dexie {
  liveTestTimers!: Table<LiveTestTimerState, string>;
  liveTestMeasurements!: Table<LiveTestMeasurementsState, string>;
  liveTestMeasurementSyncOperations!: Table<LiveTestMeasurementSyncOperation, string>;

  constructor() {
    super('masters-diagnostics');
    this.version(1).stores({
      liveTestTimers: 'testId, updatedAtMs',
    });
    this.version(2).stores({
      liveTestTimers: 'testId, updatedAtMs',
      liveTestMeasurements: 'testId, updatedAtMs',
    });
    this.version(3).stores({
      liveTestTimers: 'testId, updatedAtMs',
      liveTestMeasurements: 'testId, updatedAtMs',
      liveTestMeasurementSyncOperations:
        'operationId, testId, entityKey, status, updatedAtMs',
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
