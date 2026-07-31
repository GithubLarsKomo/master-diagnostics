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

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function verifiedStoredResult<Result>(
  stored: StoredDiagnosticResultSnapshot<unknown>,
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
      const scopedTenantId = requireIdentifier(tenantId, 'Tenant ID');
      const scopedTestId = requireIdentifier(testId, 'Test ID');
      const snapshot = await createDiagnosticResultSnapshot(result);
      const stored = await repository.append(scopedTenantId, scopedTestId, snapshot);
      const reloaded = await repository.get<Result>(
        scopedTenantId,
        scopedTestId,
        stored.versionNumber,
      );
      if (!reloaded) {
        throw new Error('Persisted diagnostic result snapshot could not be reloaded');
      }
      const verified = await verifyDiagnosticResultSnapshot<Result>(reloaded);
      return verifiedStoredResult<Result>(reloaded, verified);
    },

    async load<Result>(
      tenantId: string,
      testId: string,
      versionNumber?: number,
    ): Promise<VerifiedStoredDiagnosticResult<Result> | null> {
      const stored = await repository.get<Result>(
        requireIdentifier(tenantId, 'Tenant ID'),
        requireIdentifier(testId, 'Test ID'),
        versionNumber,
      );
      if (!stored) return null;
      const verified = await verifyDiagnosticResultSnapshot<Result>(stored);
      return verifiedStoredResult<Result>(stored, verified);
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
