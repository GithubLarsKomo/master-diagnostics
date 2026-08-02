import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemReportArtifactStorage } from './report-artifact-storage';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('report artifact storage', () => {
  it('persists and reads PDF bytes by immutable reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'masters-report-storage-'));
    roots.push(root);
    const storage = new FileSystemReportArtifactStorage(root);
    const bytes = new TextEncoder().encode('%PDF-1.4\nreport\n%%EOF');
    const reference = 'tenant-a/test-a/de/v1.pdf';
    await storage.put(reference, bytes);
    expect(Array.from(await storage.get(reference))).toEqual(Array.from(bytes));
    await expect(storage.put(reference, new Uint8Array([9]))).rejects.toThrow();
    expect(Array.from(await storage.get(reference))).toEqual(Array.from(bytes));
  });

  it('removes an orphaned artifact idempotently for DB compensation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'masters-report-storage-'));
    roots.push(root);
    const storage = new FileSystemReportArtifactStorage(root);
    const reference = 'tenant-a/test-a/en/v1.pdf';
    await storage.put(reference, new Uint8Array([1, 2, 3]));
    await storage.remove(reference);
    await expect(storage.get(reference)).rejects.toThrow();
    await expect(storage.remove(reference)).resolves.toBeUndefined();
  });

  it('rejects absolute and traversal references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'masters-report-storage-'));
    roots.push(root);
    const storage = new FileSystemReportArtifactStorage(root);
    const bytes = new Uint8Array([1]);
    await expect(storage.put('../escape.pdf', bytes)).rejects.toThrow('Invalid report storage reference');
    await expect(storage.put('/absolute.pdf', bytes)).rejects.toThrow('Invalid report storage reference');
    await expect(storage.remove('../escape.pdf')).rejects.toThrow('Invalid report storage reference');
  });
});
