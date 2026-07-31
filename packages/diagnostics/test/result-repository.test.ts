import { describe, expect, it } from 'vitest';
import { InMemoryDiagnosticResultRepository } from '../src';

function createRepository(ids = ['result-1', 'result-2']) {
  let index = 0;
  return new InMemoryDiagnosticResultRepository({
    createId: () => ids[index++] ?? 'duplicate',
    now: () => new Date('2026-07-31T19:15:00.000Z'),
  });
}

describe('append-only diagnostic result repository', () => {
  it('appends immutable records and verifies their snapshots on read', async () => {
    const repository = createRepository();
    const source = { method: 'dmax', threshold: { watts: 227.1 } };

    const record = await repository.append(source);
    source.threshold.watts = 230;

    expect(record).toMatchObject({
      id: 'result-1',
      recordedAt: '2026-07-31T19:15:00.000Z',
      snapshot: { result: { method: 'dmax', threshold: { watts: 227.1 } } },
    });
    expect(Object.isFrozen(record)).toBe(true);
    await expect(repository.read<typeof source>('result-1')).resolves.toEqual({
      method: 'dmax',
      threshold: { watts: 227.1 },
    });
  });

  it('preserves append order without exposing a mutable collection', async () => {
    const repository = createRepository();
    await repository.append({ value: 1 });
    await repository.append({ value: 2 });

    const records = repository.list();
    expect(records.map((record) => record.id)).toEqual(['result-1', 'result-2']);
    expect(Object.isFrozen(records)).toBe(true);
  });

  it('rejects duplicate or empty IDs and missing records', async () => {
    const duplicateRepository = createRepository(['same', 'same']);
    await duplicateRepository.append({ value: 1 });
    await expect(duplicateRepository.append({ value: 2 })).rejects.toThrow('already exists');

    const emptyRepository = createRepository(['   ']);
    await expect(emptyRepository.append({ value: 1 })).rejects.toThrow('must not be empty');
    await expect(duplicateRepository.read('missing')).rejects.toThrow('not found');
  });
});
