import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEncryptedBackupBundle,
  verifyBackupBundleChecksum,
} from '../src/services/backup-bundle';
import { verifyEncryptedBackupBundle } from '../src/services/backup-restore-verification';

const roots: string[] = [];
const sourceNames = [
  'libsql',
  'reports',
  'tenant-exports',
  'data-subject-delivery',
  'caddy-data',
  'caddy-config',
] as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'masters-backup-verify-test-'));
  roots.push(root);
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  const keyFile = join(root, 'backup.key');
  await mkdir(sourceDir, { recursive: true });
  for (const name of sourceNames) {
    const source = join(sourceDir, name);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'marker.txt'), `${name}\n`);
  }
  await writeFile(keyFile, `${Buffer.alloc(32, 17).toString('base64')}\n`, { mode: 0o600 });
  const created = await createEncryptedBackupBundle({
    sourceDir,
    targetDir,
    keyFile,
    createdAt: '2026-08-06T04:00:00.000Z',
  });
  return { root, keyFile, created };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('backup restore verification', () => {
  it('authenticates checksum, GCM payload, archive structure and manifest without restoring volumes', async () => {
    const { keyFile, created } = await fixture();
    const verified = await verifyEncryptedBackupBundle({
      bundlePath: created.outputPath,
      checksumPath: created.checksumPath,
      keyFile,
    });

    expect(verified).toMatchObject({
      fileName: created.fileName,
      sha256: created.sha256,
      manifest: {
        bundleVersion: 1,
        createdAt: '2026-08-06T04:00:00.000Z',
        consistency: 'CLEANLY_STOPPED_VOLUMES',
        encryption: 'AES-256-GCM',
        restoreReconciliationRequired: true,
        sources: sourceNames,
      },
    });
    expect(verified.archiveEntryCount).toBeGreaterThan(sourceNames.length);
  });

  it('rejects a checksum mismatch before attempting authenticated restore verification', async () => {
    const { keyFile, created } = await fixture();
    await writeFile(created.checksumPath, `${'0'.repeat(64)}  ${created.fileName}\n`);

    await expect(verifyEncryptedBackupBundle({
      bundlePath: created.outputPath,
      checksumPath: created.checksumPath,
      keyFile,
    })).rejects.toThrow('checksum mismatch');
  });

  it('rejects ciphertext tampering even when the sidecar checksum was recomputed', async () => {
    const { keyFile, created } = await fixture();
    const bytes = await readFile(created.outputPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await writeFile(created.outputPath, bytes);
    const tamperedChecksum = await verifyBackupBundleChecksum(created.outputPath);
    await writeFile(created.checksumPath, `${tamperedChecksum}  ${created.fileName}\n`);

    await expect(verifyEncryptedBackupBundle({
      bundlePath: created.outputPath,
      checksumPath: created.checksumPath,
      keyFile,
    })).rejects.toThrow();
  });
});
