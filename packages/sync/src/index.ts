export interface SyncOperation<T = unknown> {
  operationId: string;
  testId: string;
  entityId: string;
  expectedVersion: number;
  operationType: string;
  schemaVersion: string;
  occurredAt: string;
  payload: T;
}

export type SyncResult =
  | { status: 'APPLIED'; newVersion: number }
  | { status: 'CONFLICT'; serverVersion: number; serverState: unknown }
  | { status: 'REJECTED'; code: string };
