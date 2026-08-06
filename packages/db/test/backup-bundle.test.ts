import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEncryptedBackupBundle,
  decryptBackupBundleToTar,
  verifyBackupBundleChecksum,
} from '../src/services/backup-bundle';

const execFileAsync = promisify(execFile);
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
  const root = await mkdtemp(join(tmpdir(), 'masters-backup-bundle-'));
  roots.push(root);
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  const keyFile = join(root, 'backup.key');
  await mkdir(sourceDir, { recursive: true });
  for (const name of sourceNames) await mkdir(join(sourceDir, name), { recursive: true });
  await writeFile(join(sourceDir, 'libsql', 'database.marker'), 'db-v1\n');
  await writeFile(join(sourceDir, 'reports', 'report.marker'), 'report-v1\n');
  await writeFile(join(sourceDir, 'tenant-exports', 'tenant-export.marker'), 'tenant-export-v1\n');
  await writeFile(join(sourceDir, 'data-subject-delivery', 'subject-export.marker'), 'subject-export-v1\n');
  await writeFile(join(sourceDir, 'caddy-data', 'certificate.marker'), 'certificate-v1\n');
  await writeFile(join(sourceDir, 'caddy-config', 'config.marker'), 'config-v1\n');
  await writeFile(keyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  return { root, sourceDir, targetDir, keyFile };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('encrypted backup bundle', () => {
  it('streams every protected volume into an authenticated encrypted bundle and roundtrips', async () => {
    const { root, sourceDir, targetDir, keyFile } = await fixture();
    const createdAt = '2026-08-06T03:00:00.000Z';
    const result = await createEncryptedBackupBundle({ sourceDir, targetDir, keyFile, createdAt });

    expect(result.manifest).toEqual({
      bundleVersion: 1,
      createdAt,
      consistency: 'CLEANLY_STOPPED_VOLUMES',
      encryption: 'AES-256-GCM',
      restoreReconciliationRequired: true,
      sources: sourceNames,
    });
    const targetEntries = (await readdir(targetDir)).sort();
    expect(targetEntries).toEqual([result.fileName, `${result.fileName}.sha256`].sort());
    expect(await verifyBackupBundleChecksum(result.outputPath)).toBe(result.sha256);
    expect(await readFile(result.checksumPath, 'utf8')).toBe(`${result.sha256}  ${result.fileName}\n`);

    const tarPath = join(root, 'decrypted.tar');
    const extractDir = join(root, 'extract');
    await mkdir(extractDir);
    await decryptBackupBundleToTar(result.outputPath, keyFile, tarPath);
    await execFileAsync('tar', ['-xf', tarPath, '-C', extractDir]);

    const manifest = JSON.parse(await readFile(join(extractDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      bundleVersion: 1,
      createdAt,
      consistency: 'CLEANLY_STOPPED_VOLUMES',
      encryption: 'AES-256-GCM',
      restoreReconciliationRequired: true,
    });
    expect(await readFile(join(extractDir, 'libsql', 'database.marker'), 'utf8')).toBe('db-v1\n');
    expect(await readFile(join(extractDir, 'reports', 'report.marker'), 'utf8')).toBe('report-v1\n');
    expect(await readFile(join(extractDir, 'data-subject-delivery', 'subject-export.marker'), 'utf8')).toBe('subject-export-v1\n');
    expect(await readFile(join(extractDir, 'caddy-data', 'certificate.marker'), 'utf8')).toBe('certificate-v1\n');
    expect(await readdir(sourceDir)).not.toContain('manifest.json');
  });

  it('rejects a wrong decryption key without leaving plaintext output', async () => {
    const { root, sourceDir, targetDir, keyFile } = await fixture();
    const result = await createEncryptedBackupBundle({ sourceDir, targetDir, keyFile });
    const wrongKeyFile = join(root, 'wrong.key');
    const outputTar = join(root, 'wrong.tar');
    await writeFile(wrongKeyFile, `${Buffer.alloc(32, 8).toString('base64')}\n`);

    await expect(decryptBackupBundleToTar(result.outputPath, wrongKeyFile, outputTar)).rejects.toThrow();
    await expect(readFile(outputTar)).rejects.toThrow();
  });

  it('fails closed when one required protected volume is absent', async () => {
    const { sourceDir, targetDir, keyFile } = await fixture();
    await rm(join(sourceDir, 'reports'), { recursive: true, force: true });

    await expect(createEncryptedBackupBundle({ sourceDir, targetDir, keyFile })).rejects.toThrow('reports');
    await expect(readdir(targetDir)).rejects.toThrow();
  });
});
