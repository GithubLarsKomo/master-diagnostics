import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { decryptBackupBundleToTar } from './backup-bundle';
import {
  verifyEncryptedBackupBundle,
  type VerifiedEncryptedBackupBundle,
} from './backup-restore-verification';

const execFileAsync = promisify(execFile);
const BUNDLE_NAME_PATTERN = /^masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak$/;
const EXPECTED_SOURCE_NAMES = Object.freeze([
  'libsql',
  'reports',
  'tenant-exports',
  'data-subject-delivery',
  'caddy-data',
  'caddy-config',
] as const);

export interface StageEncryptedBackupRestoreInput {
  readonly bundlePath: string;
  readonly checksumPath: string;
  readonly keyFile: string;
  readonly stagingRoot: string;
}

export interface StagedEncryptedBackupRestore {
  readonly stagingName: string;
  readonly stagingPath: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly createdAt: string;
  readonly restoreReconciliationRequired: true;
  readonly sourceNames: readonly string[];
}

function timestampSegment(value: string): string {
  return value.replace(/[-:.]/g, '');
}

function assertArchiveContainsOnlyRegularFilesAndDirectories(verboseListing: string): void {
  const lines = verboseListing.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error('Backup archive verbose listing is empty');
  for (const line of lines) {
    const type = line[0];
    if (type !== '-' && type !== 'd') {
      throw new Error('Backup archive contains a non-regular restore entry');
    }
  }
}

async function verifyStagedTopLevel(stagingPath: string): Promise<void> {
  const entries = await readdir(stagingPath, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const expected = ['manifest.json', ...EXPECTED_SOURCE_NAMES].sort();
  if (names.join('\n') !== expected.join('\n')) {
    throw new Error('Staged restore top-level entries are invalid');
  }
  const manifest = await lstat(join(stagingPath, 'manifest.json'));
  if (!manifest.isFile()) throw new Error('Staged restore manifest is not a regular file');
  for (const source of EXPECTED_SOURCE_NAMES) {
    const info = await lstat(join(stagingPath, source));
    if (!info.isDirectory()) throw new Error(`Staged restore source is not a directory: ${source}`);
  }
}

async function copyAndVerifyEncryptedSnapshot(
  input: StageEncryptedBackupRestoreInput,
  temporaryRoot: string,
): Promise<{ readonly verified: VerifiedEncryptedBackupBundle; readonly bundleCopy: string }> {
  const fileName = basename(input.bundlePath);
  if (!BUNDLE_NAME_PATTERN.test(fileName)) throw new Error('Backup bundle file name is invalid for restore staging');
  const bundleCopy = join(temporaryRoot, fileName);
  const checksumCopy = `${bundleCopy}.sha256`;
  await copyFile(input.bundlePath, bundleCopy);
  await copyFile(input.checksumPath, checksumCopy);
  const verified = await verifyEncryptedBackupBundle({
    bundlePath: bundleCopy,
    checksumPath: checksumCopy,
    keyFile: input.keyFile,
  });
  return { verified, bundleCopy };
}

/**
 * Authenticates one encrypted backup snapshot and extracts it only into a new private staging
 * directory. The caller must not mount any production volume at stagingRoot.
 */
export async function stageEncryptedBackupRestore(
  input: StageEncryptedBackupRestoreInput,
): Promise<StagedEncryptedBackupRestore> {
  await mkdir(input.stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(input.stagingRoot, 0o700);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'masters-backup-stage-'));
  await chmod(temporaryRoot, 0o700);
  let stagingPath: string | null = null;

  try {
    const { verified, bundleCopy } = await copyAndVerifyEncryptedSnapshot(input, temporaryRoot);
    const tarPath = join(temporaryRoot, 'bundle.tar');
    await decryptBackupBundleToTar(bundleCopy, input.keyFile, tarPath);
    const verbose = await execFileAsync('tar', ['-tvf', tarPath], { maxBuffer: 16 * 1024 * 1024 });
    assertArchiveContainsOnlyRegularFilesAndDirectories(verbose.stdout);

    const stagingName = `restore-${timestampSegment(verified.manifest.createdAt)}-${randomUUID()}`;
    stagingPath = join(input.stagingRoot, stagingName);
    await mkdir(stagingPath, { mode: 0o700 });
    await execFileAsync('tar', [
      '--extract',
      '--file', tarPath,
      '--directory', stagingPath,
      '--no-same-owner',
      '--no-same-permissions',
      '--delay-directory-restore',
    ], { maxBuffer: 16 * 1024 * 1024 });
    await verifyStagedTopLevel(stagingPath);

    return Object.freeze({
      stagingName,
      stagingPath,
      fileName: verified.fileName,
      sha256: verified.sha256,
      createdAt: verified.manifest.createdAt,
      restoreReconciliationRequired: true,
      sourceNames: EXPECTED_SOURCE_NAMES,
    });
  } catch (error) {
    if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
