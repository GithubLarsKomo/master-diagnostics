import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEncryptedBackupBundle } from '../src/services/backup-bundle';
import {
  readVerifiedRestoreSourceProvenance,
  RESTORE_SOURCE_PROVENANCE_FILE_NAME,
} from '../src/services/backup-restore-source-provenance';
import { stageEncryptedBackupRestore } from '../src/services/backup-restore-staging';

const roots: string[] = [];
const sourceNames = [
  'libsql',
  'reports',
  'tenant-exports',
  'data-subject-delivery',
  'caddy-data',
  'caddy-config',
] as const;

async function fixture(options?: { symlinkEntry?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'masters-backup-stage-test-'));
  roots.push(root);
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  const stagingRoot = join(root, 'staging');
  const productionSentinel = join(root, 'production-sentinel.txt');
  const keyFile = join(root, 'backup.key');
  await mkdir(sourceDir, { recursive: true });
  for (const name of sourceNames) {
    const source = join(sourceDir, name);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'marker.txt'), `${name}\n`);
  }
  if (options?.symlinkEntry) {
    await symlink('/tmp/should-never-be-restored', join(sourceDir, 'reports', 'unsafe-link'));
  }
  await writeFile(productionSentinel, 'production untouched\n');
  await writeFile(keyFile, `${Buffer.alloc(32, 23).toString('base64')}\n`, { mode: 0o600 });
  const created = await createEncryptedBackupBundle({
    sourceDir,
    targetDir,
    keyFile,
    createdAt: '2026-08-06T05:00:00.000Z',
  });
  return { root, stagingRoot, productionSentinel, keyFile, created };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('isolated backup restore staging', () => {
  it('authenticates a private snapshot, persists signed source provenance, and extracts only below staging', async () => {
    const { stagingRoot, productionSentinel, keyFile, created } = await fixture();

    const staged = await stageEncryptedBackupRestore({
      bundlePath: created.outputPath,
      checksumPath: created.checksumPath,
      keyFile,
      stagingRoot,
    });

    expect(staged).toMatchObject({
      fileName: created.fileName,
      sha256: created.sha256,
      createdAt: '2026-08-06T05:00:00.000Z',
      restoreReconciliationRequired: true,
      sourceNames,
    });
    expect(staged.sourceProvenancePath).toBe(join(staged.stagingPath, RESTORE_SOURCE_PROVENANCE_FILE_NAME));
    expect(staged.sourceProvenanceSignature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect((await lstat(stagingRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(staged.stagingPath)).isDirectory()).toBe(true);
    expect((await readdir(staged.stagingPath)).sort()).toEqual([
      'manifest.json',
      RESTORE_SOURCE_PROVENANCE_FILE_NAME,
      ...sourceNames,
    ].sort());
    expect((await lstat(staged.sourceProvenancePath)).mode & 0o777).toBe(0o600);

    const provenance = await readVerifiedRestoreSourceProvenance(staged.sourceProvenancePath, keyFile);
    expect(provenance.signature).toBe(staged.sourceProvenanceSignature);
    expect(provenance.record).toMatchObject({
      stagingName: staged.stagingName,
      backupFileName: created.fileName,
      backupSha256: `sha256:${created.sha256}`,
      backupCreatedAt: created.createdAt,
      bundleVersion: 1,
      consistency: 'CLEANLY_STOPPED_VOLUMES',
      restoreReconciliationRequired: true,
      sourceNames,
    });
    expect(provenance.record.backupManifestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    for (const name of sourceNames) {
      expect(await readFile(join(staged.stagingPath, name, 'marker.txt'), 'utf8')).toBe(`${name}\n`);
    }
    expect(await readFile(productionSentinel, 'utf8')).toBe('production untouched\n');
  });

  it('rejects tampered restore source provenance', async () => {
    const { stagingRoot, keyFile, created } = await fixture();
    const staged = await stageEncryptedBackupRestore({
      bundlePath: created.outputPath,
      checksumPath: created.checksumPath,
      keyFile,
      stagingRoot,
    });
    const value = JSON.parse(await readFile(staged.sourceProvenancePath, 'utf8')) as {
      record: { backupSha256: string };
    };
    value.record.backupSha256 = `sha256:${'f'.repeat(64)}`;
    await writeFile(staged.sourceProvenancePath, `${JSON.stringify(value, null, 2)}\n`);
    await expect(readVerifiedRestoreSourceProvenance(staged.sourceProvenancePath, keyFile)).rejects.toThrow('signature verification failed');
  });

  it('rejects symlink archive entries before extraction and leaves no staging payload behind', async () => {
    const { stagingRoot, keyFile, created } = await fixture({ symlinkEntry: true });

    await expect(stageEncryptedBackupRestore({
      bundlePath: created.outputPath,
      checksumPath: created.checksumPath,
      keyFile,
      stagingRoot,
    })).rejects.toThrow('non-regular restore entry');

    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it('rejects non-generated bundle names before staging plaintext data', async () => {
    const { root, stagingRoot, keyFile, created } = await fixture();
    const renamed = join(root, 'manual-backup.mdbak');
    await writeFile(renamed, await readFile(created.outputPath));

    await expect(stageEncryptedBackupRestore({
      bundlePath: renamed,
      checksumPath: created.checksumPath,
      keyFile,
      stagingRoot,
    })).rejects.toThrow('file name is invalid');
    expect(await readdir(stagingRoot)).toEqual([]);
  });
});
