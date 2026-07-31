import {
  appendDiagnosticResultSnapshot,
  getDiagnosticResultSnapshot,
  type Database,
  type DiagnosticResultSnapshotEnvelope,
  type StoredDiagnosticResultSnapshot,
} from '@masters/db';
import {
  createDiagnosticResultSnapshot,
  verifyDiagnosticResultSnapshot,
  type DeepReadonly,
} from '@masters/diagnostics';

export interface DiagnosticResultSnapshotRepository {
  append<Result>(
    tenantId: string,
    testId: string,
    snapshot: DiagnosticResultSnapshotEnvelope<Result>,
  ): Promise<StoredDiagnosticResultSnapshot<Result>>;
  get<Result>(
    tenantId: string,
    testId: string,
    versionNumber?: number,
  ): Promise<StoredDiagnosticResultSnapshot<Result> | null>;
}

export interface VerifiedStoredDiagnosticResult<Result> {
  readonly id: string;
  readonly tenantId: string;
  readonly testId: string;
  readonly versionNumber: number;
  readonly resultHash: string;
  readonly result: DeepReadonly<Result>;
  readonly createdAt: string;
}

function verifiedStoredResult<Result>(
  stored: StoredDiagnosticResultSnapshot<Result>,
  result: DeepReadonly<Result>,
): VerifiedStoredDiagnosticResult<Result> {
  return Object.freeze({
    id: stored.id,
    tenantId: stored.tenantId,
    testId: stored.testId,
    versionNumber: stored.versionNumber,
    resultHash: stored.resultHash,
    result,
    createdAt: stored.createdAt,
  });
}

export function createDiagnosticResultService(repository: DiagnosticResultSnapshotRepository) {
  return {
    async persist<Result>(
      tenantId: string,
      testId: string,
      result: Result,
    ): Promise<VerifiedStoredDiagnosticResult<Result>> {
      const snapshot = await createDiagnosticResultSnapshot(result);
      const stored = await repository.append(tenantId, testId, snapshot);
      const verified = await verifyDiagnosticResultSnapshot<Result>(stored);
      return verifiedStoredResult(stored, verified);
    },

    async load<Result>(
      tenantId: string,
      testId: string,
      versionNumber?: number,
    ): Promise<VerifiedStoredDiagnosticResult<Result> | null> {
      const stored = await repository.get<Result>(tenantId, testId, versionNumber);
      if (!stored) return null;
      const verified = await verifyDiagnosticResultSnapshot<Result>(stored);
      return verifiedStoredResult(stored, verified);
    },
  };
}

export function createDatabaseDiagnosticResultService(db: Database) {
  return createDiagnosticResultService({
    append: <Result>(
      tenantId: string,
      testId: string,
      snapshot: DiagnosticResultSnapshotEnvelope<Result>,
    ) => appendDiagnosticResultSnapshot(db, tenantId, testId, snapshot),
    get: <Result>(tenantId: string, testId: string, versionNumber?: number) =>
      getDiagnosticResultSnapshot<Result>(db, tenantId, testId, versionNumber),
  });
}
