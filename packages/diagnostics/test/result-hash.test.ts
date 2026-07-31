import { describe, expect, it } from 'vitest';
import {
  canonicalizeDiagnosticResult,
  createDiagnosticResultHash,
} from '../src';

describe('diagnostic result hashing', () => {
  it('canonicalizes nested object keys while preserving array order', () => {
    const left = {
      warnings: [],
      method: 'fixed',
      lt2: { watts: 270, lactate: 4 },
    };
    const right = {
      lt2: { lactate: 4, watts: 270 },
      method: 'fixed',
      warnings: [],
    };

    expect(canonicalizeDiagnosticResult(left)).toBe(
      '{"lt2":{"lactate":4,"watts":270},"method":"fixed","warnings":[]}',
    );
    expect(canonicalizeDiagnosticResult(right)).toBe(canonicalizeDiagnosticResult(left));
    expect(canonicalizeDiagnosticResult({ values: [1, 2] })).not.toBe(
      canonicalizeDiagnosticResult({ values: [2, 1] }),
    );
  });

  it('produces a stable versioned SHA-256 fingerprint', async () => {
    const result = {
      lt2: { watts: 270, lactate: 4 },
      method: 'fixed',
      warnings: [],
    };

    await expect(createDiagnosticResultHash(result)).resolves.toBe(
      'sha256:f6c9d484d3252a0748575481e1c17610880e2835e70225e964dbd4564036c7ae',
    );
    await expect(
      createDiagnosticResultHash({ warnings: [], method: 'fixed', lt2: { lactate: 4, watts: 270 } }),
    ).resolves.toBe(
      'sha256:f6c9d484d3252a0748575481e1c17610880e2835e70225e964dbd4564036c7ae',
    );
  });

  it('normalizes negative zero and rejects lossy JSON values', () => {
    expect(canonicalizeDiagnosticResult(-0)).toBe('0');
    expect(() => canonicalizeDiagnosticResult(Number.NaN)).toThrow('finite numbers');
    expect(() => canonicalizeDiagnosticResult({ value: undefined })).toThrow('undefined');
    expect(() => canonicalizeDiagnosticResult(new Date())).toThrow('plain JSON objects');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeDiagnosticResult(cyclic)).toThrow('cyclic values');
  });
});
