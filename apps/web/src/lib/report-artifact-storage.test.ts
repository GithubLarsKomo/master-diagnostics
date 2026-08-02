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
    await storage.put('tenant-a/test-a/de/v1.pdf', bytes);
    expect(Array.from(await storage.get('tenant-a/test-a/de/v1.pdf'))).toEqual(Array.from(bytes));
  });

  it('rejects absolute and traversal references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'masters-report-storage-'));
    roots.push(root);
    const storage = new FileSystemReportArtifactStorage(root);
    const bytes = new Uint8Array([1]);
    await expect(storage.put('../escape.pdf', bytes)).rejects.toThrow('Invalid report storage reference');
    await expect(storage.put('/absolute.pdf', bytes)).rejects.toThrow('Invalid report storage reference');
  });
});
