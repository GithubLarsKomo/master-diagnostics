import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_RESULT_CANONICALIZATION,
  DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA,
  createDiagnosticResultSnapshot,
  verifyDiagnosticResultSnapshot,
} from '../src';

describe('diagnostic result snapshots', () => {
  it('creates a detached and deeply frozen persistable envelope', async () => {
    const source = {
      method: 'fixed',
      thresholds: [{ name: 'lt2', watts: 270 }],
    };

    const snapshot = await createDiagnosticResultSnapshot(source);
    source.thresholds[0]!.watts = 280;

    expect(snapshot).toMatchObject({
      schemaVersion: DIAGNOSTIC_RESULT_SNAPSHOT_SCHEMA,
      canonicalization: DIAGNOSTIC_RESULT_CANONICALIZATION,
      resultHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      result: {
        method: 'fixed',
        thresholds: [{ name: 'lt2', watts: 270 }],
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.result)).toBe(true);
    expect(Object.isFrozen(snapshot.result.thresholds)).toBe(true);
    expect(Object.isFrozen(snapshot.result.thresholds[0])).toBe(true);
  });

  it('verifies persisted content independently of object key order', async () => {
    const snapshot = await createDiagnosticResultSnapshot({
      method: 'fixed',
      lt2: { watts: 270, lactate: 4 },
    });
    const persisted = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    persisted.result = {
      lt2: { lactate: 4, watts: 270 },
      method: 'fixed',
    };

    const result = await verifyDiagnosticResultSnapshot<{
      method: string;
      lt2: { watts: number; lactate: number };
    }>(persisted);

    expect(result.lt2.watts).toBe(270);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lt2)).toBe(true);
  });

  it('rejects tampering and unsupported snapshot contracts', async () => {
    const snapshot = await createDiagnosticResultSnapshot({ method: 'fixed', lt2: 270 });
    const tampered = JSON.parse(JSON.stringify(snapshot)) as {
      schemaVersion: string;
      canonicalization: string;
      resultHash: string;
      result: { method: string; lt2: number };
    };
    tampered.result.lt2 = 280;

    await expect(verifyDiagnosticResultSnapshot(tampered)).rejects.toThrow('integrity verification failed');

    await expect(
      verifyDiagnosticResultSnapshot({ ...snapshot, schemaVersion: 'diagnostic-result-snapshot-v2' }),
    ).rejects.toThrow('Unsupported diagnostic result snapshot schema');

    await expect(
      verifyDiagnosticResultSnapshot({ ...snapshot, canonicalization: 'diagnostic-json-v2' }),
    ).rejects.toThrow('Unsupported diagnostic result canonicalization');
  });
});
