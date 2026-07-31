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
  it('creates, persists, reloads and verifies a result before returning it', async () => {
    let appended: DiagnosticResultSnapshotEnvelope<unknown> | null = null;
    let loadedVersion: number | undefined;
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(
        tenantId: string,
        testId: string,
        snapshot: DiagnosticResultSnapshotEnvelope<Result>,
      ) {
        expect(tenantId).toBe('tenant-a');
        expect(testId).toBe('test-a');
        appended = snapshot as DiagnosticResultSnapshotEnvelope<unknown>;
        return stored(snapshot);
      },
      async get<Result>(tenantId: string, testId: string, versionNumber?: number) {
        expect(tenantId).toBe('tenant-a');
        expect(testId).toBe('test-a');
        loadedVersion = versionNumber;
        return stored(appended as DiagnosticResultSnapshotEnvelope<Result>);
      },
    };
    const service = createDiagnosticResultService(repository);

    const saved = await service.persist(' tenant-a ', ' test-a ', {
      method: 'fixed',
      lt2: { watts: 270, lactate: 4 },
    });

    expect(appended).toMatchObject({
      schemaVersion: 'diagnostic-result-snapshot-v1',
      canonicalization: 'diagnostic-json-v1',
      resultHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(loadedVersion).toBe(1);
    expect(saved.result.lt2.watts).toBe(270);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.result)).toBe(true);
    expect(Object.isFrozen(saved.result.lt2)).toBe(true);
  });

  it('rejects a manipulated persisted snapshot when loading', async () => {
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(
        _tenantId: string,
        _testId: string,
        snapshot: DiagnosticResultSnapshotEnvelope<Result>,
      ) {
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

  it('rejects empty scope identifiers and a missing persisted reload', async () => {
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(
        _tenantId: string,
        _testId: string,
        snapshot: DiagnosticResultSnapshotEnvelope<Result>,
      ) {
        return stored(snapshot);
      },
      async get() {
        return null;
      },
    };
    const service = createDiagnosticResultService(repository);

    await expect(service.load(' ', 'test-a')).rejects.toThrow('Tenant ID is required');
    await expect(service.load('tenant-a', ' ')).rejects.toThrow('Test ID is required');
    await expect(service.persist('tenant-a', 'test-a', { value: 1 })).rejects.toThrow(
      'could not be reloaded',
    );
  });

  it('returns null when no persisted version exists', async () => {
    const repository: DiagnosticResultSnapshotRepository = {
      async append<Result>(
        _tenantId: string,
        _testId: string,
        snapshot: DiagnosticResultSnapshotEnvelope<Result>,
      ) {
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
