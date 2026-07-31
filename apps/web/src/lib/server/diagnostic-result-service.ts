import {
  appendDiagnosticResultSnapshot,
  getDiagnosticResultSnapshot,
  type Database,
  type StoredDiagnosticResultSnapshot,
} from '@masters/db';
import {
  createDiagnosticResultSnapshot,
  verifyDiagnosticResultSnapshot,
  type DeepReadonly,
} from '@masters/diagnostics';

export interface PersistedVerifiedDiagnosticResult<Result> {
  readonly id: string;
  readonly tenantId: string;
  readonly testId: string;
  readonly versionNumber: number;
  readonly resultHash: string;
  readonly createdAt: string;
  readonly result: DeepReadonly<Result>;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

async function verifyStoredResult<Result>(
  stored: StoredDiagnosticResultSnapshot<Result>,
): Promise<PersistedVerifiedDiagnosticResult<Result>> {
  const result = await verifyDiagnosticResultSnapshot<Result>({
    schemaVersion: stored.schemaVersion,
    canonicalization: stored.canonicalization,
    resultHash: stored.resultHash,
    result: stored.result,
  });

  return Object.freeze({
    id: stored.id,
    tenantId: stored.tenantId,
    testId: stored.testId,
    versionNumber: stored.versionNumber,
    resultHash: stored.resultHash,
    createdAt: stored.createdAt,
    result,
  });
}

/** Creates, persists, reloads and verifies one immutable diagnostic result version. */
export async function persistVerifiedDiagnosticResult<Result>(
  db: Database,
  tenantId: string,
  testId: string,
  result: Result,
): Promise<PersistedVerifiedDiagnosticResult<Result>> {
  const scopedTenantId = requireIdentifier(tenantId, 'Tenant ID');
  const scopedTestId = requireIdentifier(testId, 'Test ID');
  const snapshot = await createDiagnosticResultSnapshot(result);

  const stored = await appendDiagnosticResultSnapshot(
    db,
    scopedTenantId,
    scopedTestId,
    snapshot,
  );
  const reloaded = await getDiagnosticResultSnapshot<Result>(
    db,
    scopedTenantId,
    scopedTestId,
    stored.versionNumber,
  );
  if (!reloaded) throw new Error('Persisted diagnostic result snapshot could not be reloaded');

  return verifyStoredResult(reloaded);
}

/** Reads and verifies the latest or an explicit immutable diagnostic result version. */
export async function readVerifiedDiagnosticResult<Result>(
  db: Database,
  tenantId: string,
  testId: string,
  versionNumber?: number,
): Promise<PersistedVerifiedDiagnosticResult<Result> | null> {
  const stored = await getDiagnosticResultSnapshot<Result>(
    db,
    requireIdentifier(tenantId, 'Tenant ID'),
    requireIdentifier(testId, 'Test ID'),
    versionNumber,
  );
  return stored ? verifyStoredResult(stored) : null;
}
