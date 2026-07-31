import {
  DIAGNOSTIC_RESULT_CANONICALIZATION,
  DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA,
  canonicalizeDiagnosticResult,
  createDiagnosticResultSnapshot,
  verifyDiagnosticResultSnapshot,
  type DeepReadonly,
  type DiagnosticResultHash,
} from '@masters/diagnostics';
import { and, desc, eq, max } from 'drizzle-orm';
import type { Database } from '../client';
import { diagnosticResultSnapshots, tests } from '../schema';

export interface StoredDiagnosticResultSnapshot<Result = unknown> {
  id: string;
  tenantId: string;
  testId: string;
  versionNumber: number;
  resultHash: DiagnosticResultHash;
  result: DeepReadonly<Result>;
  createdAt: string;
}

async function requireTenantTest(
  db: Database,
  tenantId: string,
  testId: string,
): Promise<void> {
  const [test] = await db
    .select({ id: tests.id })
    .from(tests)
    .where(and(eq(tests.tenantId, tenantId), eq(tests.id, testId)))
    .limit(1);
  if (!test) throw new Error('Diagnostic test not found for tenant');
}

function persistedEnvelope(row: typeof diagnosticResultSnapshots.$inferSelect): unknown {
  let result: unknown;
  try {
    result = JSON.parse(row.resultJson) as unknown;
  } catch {
    throw new Error('Persisted diagnostic result snapshot contains invalid JSON');
  }
  return {
    schemaVersion: row.schemaVersion,
    canonicalization: row.canonicalization,
    resultHash: row.resultHash,
    result,
  };
}

async function verifiedStoredSnapshot<Result>(
  row: typeof diagnosticResultSnapshots.$inferSelect,
): Promise<StoredDiagnosticResultSnapshot<Result>> {
  const result = await verifyDiagnosticResultSnapshot<Result>(persistedEnvelope(row));
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    testId: row.testId,
    versionNumber: row.versionNumber,
    resultHash: row.resultHash as DiagnosticResultHash,
    result,
    createdAt: row.createdAt,
  });
}

/** Appends a new immutable version for one tenant-bound diagnostic test. */
export async function appendDiagnosticResultSnapshot<Result>(
  db: Database,
  tenantId: string,
  testId: string,
  result: Result,
): Promise<StoredDiagnosticResultSnapshot<Result>> {
  await requireTenantTest(db, tenantId, testId);
  const snapshot = await createDiagnosticResultSnapshot(result);

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ versionNumber: max(diagnosticResultSnapshots.versionNumber) })
      .from(diagnosticResultSnapshots)
      .where(and(
        eq(diagnosticResultSnapshots.tenantId, tenantId),
        eq(diagnosticResultSnapshots.testId, testId),
      ));
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const now = new Date().toISOString();
    const [created] = await tx.insert(diagnosticResultSnapshots).values({
      id: crypto.randomUUID(),
      tenantId,
      testId,
      versionNumber,
      schemaVersion: DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA,
      canonicalization: DIAGNOSTIC_RESULT_CANONICALIZATION,
      resultHash: snapshot.resultHash,
      resultJson: canonicalizeDiagnosticResult(snapshot.result),
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!created) throw new Error('Diagnostic result snapshot was not persisted');
    return verifiedStoredSnapshot<Result>(created);
  });
}

/** Reads and verifies one immutable version, or the latest version when omitted. */
export async function getDiagnosticResultSnapshot<Result>(
  db: Database,
  tenantId: string,
  testId: string,
  versionNumber?: number,
): Promise<StoredDiagnosticResultSnapshot<Result> | null> {
  if (versionNumber !== undefined && (!Number.isInteger(versionNumber) || versionNumber < 1)) {
    throw new Error('Diagnostic result snapshot version must be a positive integer');
  }
  const conditions = [
    eq(diagnosticResultSnapshots.tenantId, tenantId),
    eq(diagnosticResultSnapshots.testId, testId),
  ];
  if (versionNumber !== undefined) {
    conditions.push(eq(diagnosticResultSnapshots.versionNumber, versionNumber));
  }
  const [row] = await db
    .select()
    .from(diagnosticResultSnapshots)
    .where(and(...conditions))
    .orderBy(desc(diagnosticResultSnapshots.versionNumber))
    .limit(1);
  return row ? verifiedStoredSnapshot<Result>(row) : null;
}
