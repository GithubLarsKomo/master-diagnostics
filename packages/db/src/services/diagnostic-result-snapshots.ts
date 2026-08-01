import { and, desc, eq, max } from 'drizzle-orm';
import type { Database } from '../client';
import { diagnosticResultSnapshots, tests } from '../schema';

export interface DiagnosticResultSnapshotEnvelope<Result = unknown> {
  schemaVersion: string;
  canonicalization: string;
  resultHash: string;
  result: Result;
}

export interface StoredDiagnosticResultSnapshot<Result = unknown>
  extends DiagnosticResultSnapshotEnvelope<Result> {
  id: string;
  tenantId: string;
  testId: string;
  versionNumber: number;
  createdAt: string;
}

export interface AthleteDiagnosticResultHistoryItem {
  id: string;
  testId: string;
  testCreatedAt: string;
  testStatus: string;
  versionNumber: number;
  schemaVersion: string;
  resultHash: string;
  createdAt: string;
}

function validateEnvelope<Result>(
  snapshot: DiagnosticResultSnapshotEnvelope<Result>,
): string {
  if (!snapshot.schemaVersion.trim()) {
    throw new Error('Diagnostic result snapshot schema version is required');
  }
  if (!snapshot.canonicalization.trim()) {
    throw new Error('Diagnostic result canonicalization is required');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.resultHash)) {
    throw new Error('Diagnostic result snapshot hash is invalid');
  }
  const resultJson = JSON.stringify(snapshot.result);
  if (resultJson === undefined) {
    throw new Error('Diagnostic result snapshot payload is not JSON serializable');
  }
  return resultJson;
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

function storedSnapshot<Result>(
  row: typeof diagnosticResultSnapshots.$inferSelect,
): StoredDiagnosticResultSnapshot<Result> {
  let result: Result;
  try {
    result = JSON.parse(row.resultJson) as Result;
  } catch {
    throw new Error('Persisted diagnostic result snapshot contains invalid JSON');
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    testId: row.testId,
    versionNumber: row.versionNumber,
    schemaVersion: row.schemaVersion,
    canonicalization: row.canonicalization,
    resultHash: row.resultHash,
    result,
    createdAt: row.createdAt,
  });
}

/** Appends a new immutable snapshot version for one tenant-bound test. */
export async function appendDiagnosticResultSnapshot<Result>(
  db: Database,
  tenantId: string,
  testId: string,
  snapshot: DiagnosticResultSnapshotEnvelope<Result>,
): Promise<StoredDiagnosticResultSnapshot<Result>> {
  const resultJson = validateEnvelope(snapshot);
  await requireTenantTest(db, tenantId, testId);

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
      schemaVersion: snapshot.schemaVersion,
      canonicalization: snapshot.canonicalization,
      resultHash: snapshot.resultHash,
      resultJson,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!created) throw new Error('Diagnostic result snapshot was not persisted');
    return storedSnapshot<Result>(created);
  });
}

/** Reads one immutable version, or the latest version when omitted. */
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
  return row ? storedSnapshot<Result>(row) : null;
}

/** Lists immutable diagnostic result versions for one athlete inside the tenant boundary. */
export async function listAthleteDiagnosticResultHistory(
  db: Database,
  tenantId: string,
  athleteId: string,
): Promise<readonly AthleteDiagnosticResultHistoryItem[]> {
  const rows = await db
    .select({
      id: diagnosticResultSnapshots.id,
      testId: diagnosticResultSnapshots.testId,
      testCreatedAt: tests.createdAt,
      testStatus: tests.status,
      versionNumber: diagnosticResultSnapshots.versionNumber,
      schemaVersion: diagnosticResultSnapshots.schemaVersion,
      resultHash: diagnosticResultSnapshots.resultHash,
      createdAt: diagnosticResultSnapshots.createdAt,
    })
    .from(diagnosticResultSnapshots)
    .innerJoin(tests, and(
      eq(tests.id, diagnosticResultSnapshots.testId),
      eq(tests.tenantId, tenantId),
      eq(tests.athleteId, athleteId),
    ))
    .where(eq(diagnosticResultSnapshots.tenantId, tenantId))
    .orderBy(desc(diagnosticResultSnapshots.createdAt), desc(diagnosticResultSnapshots.versionNumber));

  return Object.freeze(rows.map((row) => Object.freeze(row)));
}
