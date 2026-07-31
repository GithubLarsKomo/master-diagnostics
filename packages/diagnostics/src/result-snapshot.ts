import {
  DIAGNOSTIC_RESULT_CANONICALIZATION,
  type DiagnosticResultHash,
  canonicalizeDiagnosticResult,
  createDiagnosticResultHash,
} from './result-hash';

export const DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA = 'diagnostic-result-snapshot-v1' as const;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface DiagnosticResultSnapshot<Result = unknown> {
  readonly schemaVersion: typeof DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA;
  readonly canonicalization: typeof DIAGNOSTIC_RESULT_CANONICALIZATION;
  readonly resultHash: DiagnosticResultHash;
  readonly result: DeepReadonly<Result>;
}

function cloneCanonical<Result>(result: Result): DeepReadonly<Result> {
  return JSON.parse(canonicalizeDiagnosticResult(result)) as DeepReadonly<Result>;
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value as DeepReadonly<Value>;
}

function assertSnapshotEnvelope(value: unknown): asserts value is DiagnosticResultSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Diagnostic result snapshot must be a plain object.');
  }

  const snapshot = value as Partial<DiagnosticResultSnapshot>;
  if (snapshot.schemaVersion !== DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA) {
    throw new Error(`Unsupported diagnostic result snapshot schema: ${String(snapshot.schemaVersion)}.`);
  }
  if (snapshot.canonicalization !== DIAGNOSTIC_RESULT_CANONICALIZATION) {
    throw new Error(`Unsupported diagnostic result canonicalization: ${String(snapshot.canonicalization)}.`);
  }
  if (typeof snapshot.resultHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(snapshot.resultHash)) {
    throw new TypeError('Diagnostic result snapshot contains an invalid SHA-256 hash.');
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'result')) {
    throw new TypeError('Diagnostic result snapshot is missing its result payload.');
  }
}

/** Creates a detached, deeply frozen and persistable diagnostic result snapshot. */
export async function createDiagnosticResultSnapshot<Result>(
  result: Result,
): Promise<DiagnosticResultSnapshot<Result>> {
  const detachedResult = deepFreeze(cloneCanonical(result)) as DeepReadonly<Result>;
  const resultHash = await createDiagnosticResultHash(detachedResult);
  const snapshot: DiagnosticResultSnapshot<Result> = {
    schemaVersion: DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA,
    canonicalization: DIAGNOSTIC_RESULT_CANONICALIZATION,
    resultHash,
    result: detachedResult,
  };
  return deepFreeze(snapshot) as DiagnosticResultSnapshot<Result>;
}

/** Verifies a persisted snapshot before returning a detached, immutable result payload. */
export async function verifyDiagnosticResultSnapshot<Result>(
  value: unknown,
): Promise<DeepReadonly<Result>> {
  assertSnapshotEnvelope(value);
  const detachedResult = deepFreeze(cloneCanonical(value.result)) as DeepReadonly<Result>;
  const actualHash = await createDiagnosticResultHash(detachedResult);
  if (actualHash !== value.resultHash) {
    throw new Error('Diagnostic result snapshot integrity verification failed.');
  }
  return detachedResult;
}
