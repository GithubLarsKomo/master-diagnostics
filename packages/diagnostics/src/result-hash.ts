export const DIAGNOSTIC_RESULT_CANONICALIZATION = 'diagnostic-json-v1' as const;

export type DiagnosticResultHash = `sha256:${string}`;

function stringifyScalar(value: string | boolean | number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Diagnostic result value cannot be serialized.');
  }
  return serialized;
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return stringifyScalar(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Diagnostic result hashes require finite numbers.');
    }
    return Object.is(value, -0) ? '0' : stringifyScalar(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Diagnostic result hashes do not support cyclic values.');
    }
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Diagnostic result hashes support plain JSON objects only.');
    }
    if (ancestors.has(value)) {
      throw new TypeError('Diagnostic result hashes do not support cyclic values.');
    }

    ancestors.add(value);
    try {
      const entries = Object.keys(value)
        .sort()
        .map((key) => `${stringifyScalar(key)}:${canonicalize((value as Record<string, unknown>)[key], ancestors)}`);
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }

  throw new TypeError(`Diagnostic result hashes do not support values of type ${typeof value}.`);
}

/**
 * Serializes a JSON-compatible diagnostic result with recursively sorted object keys.
 * Array order remains significant. Undefined values, non-finite numbers, class instances,
 * bigint, symbols, functions and cyclic structures are rejected instead of being omitted.
 */
export function canonicalizeDiagnosticResult(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Produces a versioned SHA-256 fingerprint for a diagnostic result.
 */
export async function createDiagnosticResultHash(value: unknown): Promise<DiagnosticResultHash> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 hashing requires the Web Crypto API.');
  }

  const canonicalResult = canonicalizeDiagnosticResult(value);
  const payload = `{"canonicalization":"${DIAGNOSTIC_RESULT_CANONICALIZATION}","result":${canonicalResult}}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `sha256:${toHex(digest)}`;
}
