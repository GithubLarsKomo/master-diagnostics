import { describe, expect, it } from 'vitest';
import type {
  DiagnosticResultSnapshotEnvelope,
  StoredDiagnosticResultSnapshot,
} from '@masters/db';
import {
  createDiagnosticResultService,
  type DiagnosticResultSnapshotRepository,
} from './diagnostic-result-service';

function stored<Result>(
  snapshot: DiagnosticResultSnapshotEnvelope<Result>,
): StoredDiagnosticResultSnapshot<Result> {
  return {
    id: 'result-1',
    tenantId: 'tenant-a',
    testId: 'test-a',
    versionNumber: 1,
    createdAt: '2026-07-31T19:00:00.000Z',
    ...snapshot,
  };
}

describe('diagnostic result application service', () => {
  it('creates, persists and verifies a result before returning it', async () => {
    let appended: DiagnosticResultSnapshotEnvelope<unknown> | null = null;
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(_tenantId, _testId, snapshot) {
        appended = snapshot as DiagnosticResultSnapshotEnvelope<unknown>;
        return stored(snapshot);
      },
      async get() {
        return null;
      },
    };
    const service = createDiagnosticResultService(repository);

    const saved = await service.persist('tenant-a', 'test-a', {
      method: 'fixed',
      lt2: { watts: 270, lactate: 4 },
    });

    expect(appended).toMatchObject({
      schemaVersion: 'diagnostic-result-snapshot-v1',
      canonicalization: 'diagnostic-json-v1',
      resultHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(saved.result.lt2.watts).toBe(270);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.result)).toBe(true);
    expect(Object.isFrozen(saved.result.lt2)).toBe(true);
  });

  it('rejects a manipulated persisted snapshot when loading', async () => {
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(_tenantId, _testId, snapshot) {
        return stored(snapshot);
      },
      async get<Result>() {
        return {
          id: 'result-1',
          tenantId: 'tenant-a',
          testId: 'test-a',
          versionNumber: 1,
          schemaVersion: 'diagnostic-result-snapshot-v1',
          canonicalization: 'diagnostic-json-v1',
          resultHash: `sha256:${'0'.repeat(64)}`,
          result: { method: 'fixed', lt2: 280 } as Result,
          createdAt: '2026-07-31T19:00:00.000Z',
        };
      },
    };
    const service = createDiagnosticResultService(repository);

    await expect(service.load('tenant-a', 'test-a')).rejects.toThrow(
      'integrity verification failed',
    );
  });

  it('returns null when no persisted version exists', async () => {
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(_tenantId, _testId, snapshot) {
        return stored(snapshot);
      },
      async get() {
        return null;
      },
    };
    const service = createDiagnosticResultService(repository);

    await expect(service.load('tenant-a', 'missing-test')).resolves.toBeNull();
  });
});
