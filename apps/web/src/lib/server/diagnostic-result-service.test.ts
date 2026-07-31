import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, StoredDiagnosticResultSnapshot } from '@masters/db';

const { appendDiagnosticResultSnapshot, getDiagnosticResultSnapshot } = vi.hoisted(() => ({
  appendDiagnosticResultSnapshot: vi.fn(),
  getDiagnosticResultSnapshot: vi.fn(),
}));

vi.mock('@masters/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@masters/db')>()),
  appendDiagnosticResultSnapshot,
  getDiagnosticResultSnapshot,
}));

import {
  persistVerifiedDiagnosticResult,
  readVerifiedDiagnosticResult,
} from './diagnostic-result-service';

const db = {} as Database;

function stored<Result>(result: Result): StoredDiagnosticResultSnapshot<Result> {
  return {
    id: 'result-1',
    tenantId: 'tenant-a',
    testId: 'test-a',
    versionNumber: 1,
    schemaVersion: 'diagnostic-result-snapshot-v1',
    canonicalization: 'diagnostic-json-v1',
    resultHash: 'sha256:f6c9d484d3252a0748575481e1c17610880e2835e70225e964dbd4564036c7ae',
    result,
    createdAt: '2026-07-31T19:55:00.000Z',
  };
}

describe('diagnostic result application service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates, persists, reloads and verifies an immutable result', async () => {
    const result = { lt2: { lactate: 4, watts: 270 }, method: 'fixed', warnings: [] };
    const persisted = stored(result);
    appendDiagnosticResultSnapshot.mockResolvedValue(persisted);
    getDiagnosticResultSnapshot.mockResolvedValue(persisted);

    const response = await persistVerifiedDiagnosticResult(db, ' tenant-a ', ' test-a ', result);

    expect(appendDiagnosticResultSnapshot).toHaveBeenCalledWith(
      db,
      'tenant-a',
      'test-a',
      expect.objectContaining({
        schemaVersion: 'diagnostic-result-snapshot-v1',
        canonicalization: 'diagnostic-json-v1',
      }),
    );
    expect(getDiagnosticResultSnapshot).toHaveBeenCalledWith(db, 'tenant-a', 'test-a', 1);
    expect(response.result).toEqual(result);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.result)).toBe(true);
  });

  it('rejects a persisted payload whose hash no longer matches', async () => {
    getDiagnosticResultSnapshot.mockResolvedValue(
      stored({ lt2: { lactate: 4, watts: 280 }, method: 'fixed', warnings: [] }),
    );

    await expect(
      readVerifiedDiagnosticResult(db, 'tenant-a', 'test-a'),
    ).rejects.toThrow('integrity verification failed');
  });

  it('rejects empty scope identifiers and missing reloads', async () => {
    await expect(readVerifiedDiagnosticResult(db, ' ', 'test-a')).rejects.toThrow('Tenant ID is required');

    const result = { value: 1 };
    appendDiagnosticResultSnapshot.mockResolvedValue(stored(result));
    getDiagnosticResultSnapshot.mockResolvedValue(null);
    await expect(
      persistVerifiedDiagnosticResult(db, 'tenant-a', 'test-a', result),
    ).rejects.toThrow('could not be reloaded');
  });
});
