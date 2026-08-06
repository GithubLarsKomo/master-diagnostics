import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_RETENTION_COUNT,
  parseBackupRetentionCount,
  pruneCompletedBackupBundles,
} from '../src/services/backup-retention';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'masters-backup-retention-'));
  roots.push(root);
  return root;
}

function bundleName(index: number): string {
  const day = String(index + 1).padStart(2, '0');
  return `masters-backup-202607${day}T030000000Z-00000000-0000-4000-8000-${String(index).padStart(12, '0')}.mdbak`;
}

async function writePair(root: string, name: string): Promise<void> {
  await writeFile(join(root, name), `bundle:${name}`);
  await writeFile(join(root, `${name}.sha256`), `checksum:${name}`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('backup retention', () => {
  it('defaults to 30 and rejects unsafe retention counts', () => {
    expect(parseBackupRetentionCount(undefined)).toBe(DEFAULT_BACKUP_RETENTION_COUNT);
    expect(parseBackupRetentionCount('30')).toBe(30);
    expect(() => parseBackupRetentionCount('0')).toThrow('between 1 and 365');
    expect(() => parseBackupRetentionCount('366')).toThrow('between 1 and 365');
    expect(() => parseBackupRetentionCount('30.5')).toThrow('integer');
  });

  it('keeps the newest complete pairs and prunes only older complete pairs', async () => {
    const root = await createRoot();
    const names = Array.from({ length: 33 }, (_, index) => bundleName(index));
    for (const name of names) await writePair(root, name);

    const result = await pruneCompletedBackupBundles(root, 30);

    expect(result).toEqual({
      keepCount: 30,
      completeBackupCountBeforePrune: 33,
      keptCount: 30,
      prunedCount: 3,
      orphanBundleCount: 0,
      orphanChecksumCount: 0,
    });
    const remaining = new Set(await readdir(root));
    for (const name of names.slice(0, 3)) {
      expect(remaining.has(name)).toBe(false);
      expect(remaining.has(`${name}.sha256`)).toBe(false);
    }
    for (const name of names.slice(3)) {
      expect(remaining.has(name)).toBe(true);
      expect(remaining.has(`${name}.sha256`)).toBe(true);
    }
  });

  it('retains orphaned files for operator review and does not count them as complete backups', async () => {
    const root = await createRoot();
    const complete = bundleName(20);
    const orphanBundle = bundleName(21);
    const orphanChecksumBundle = bundleName(22);
    await writePair(root, complete);
    await writeFile(join(root, orphanBundle), 'orphan bundle');
    await writeFile(join(root, `${orphanChecksumBundle}.sha256`), 'orphan checksum');
    await writeFile(join(root, 'unrelated.txt'), 'unrelated');

    const result = await pruneCompletedBackupBundles(root, 1);

    expect(result).toEqual({
      keepCount: 1,
      completeBackupCountBeforePrune: 1,
      keptCount: 1,
      prunedCount: 0,
      orphanBundleCount: 1,
      orphanChecksumCount: 1,
    });
    expect(await readFile(join(root, orphanBundle), 'utf8')).toBe('orphan bundle');
    expect(await readFile(join(root, `${orphanChecksumBundle}.sha256`), 'utf8')).toBe('orphan checksum');
  });
});
