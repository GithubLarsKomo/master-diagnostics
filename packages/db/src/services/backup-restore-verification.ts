import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  BACKUP_BUNDLE_VERSION,
  decryptBackupBundleToTar,
  verifyBackupBundleChecksum,
  type BackupManifest,
  type BackupSourceName,
} from './backup-bundle';

const execFileAsync = promisify(execFile);
const EXPECTED_SOURCES = Object.freeze([
  'libsql',
  'reports',
  'tenant-exports',
  'data-subject-delivery',
  'caddy-data',
  'caddy-config',
] as const satisfies readonly BackupSourceName[]);
const EXPECTED_TOP_LEVEL = Object.freeze(['manifest.json', ...EXPECTED_SOURCES].sort());

export interface VerifyEncryptedBackupBundleInput {
  readonly bundlePath: string;
  readonly checksumPath: string;
  readonly keyFile: string;
}

export interface VerifiedEncryptedBackupBundle {
  readonly fileName: string;
  readonly sha256: string;
  readonly manifest: BackupManifest;
}

function parseChecksumFile(content: string, expectedFileName: string): string {
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/.exec(content);
  if (!match) throw new Error('Backup checksum file format is invalid');
  const [, checksum, fileName] = match;
  if (fileName !== expectedFileName) throw new Error('Backup checksum file names a different bundle');
  return checksum;
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backup manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.bundleVersion !== BACKUP_BUNDLE_VERSION) throw new Error('Backup manifest version is unsupported');
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('Backup manifest creation time is invalid');
  }
  if (manifest.consistency !== 'CLEANLY_STOPPED_VOLUMES') throw new Error('Backup consistency mode is unsupported');
  if (manifest.encryption !== 'AES-256-GCM') throw new Error('Backup encryption mode is unsupported');
  if (manifest.restoreReconciliationRequired !== true) {
    throw new Error('Backup manifest must require restore privacy reconciliation');
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== EXPECTED_SOURCES.length) {
    throw new Error('Backup manifest source set is invalid');
  }
  if (!EXPECTED_SOURCES.every((source, index) => manifest.sources?.[index] === source)) {
    throw new Error('Backup manifest source set is invalid');
  }
  if (Object.keys(manifest).sort().join('\n') !== [
    'bundleVersion',
    'consistency',
    'createdAt',
    'encryption',
    'restoreReconciliationRequired',
    'sources',
  ].sort().join('\n')) {
    throw new Error('Backup manifest contains unsupported fields');
  }
  return Object.freeze({
    bundleVersion: BACKUP_BUNDLE_VERSION,
    createdAt: manifest.createdAt,
    consistency: 'CLEANLY_STOPPED_VOLUMES',
    encryption: 'AES-256-GCM',
    restoreReconciliationRequired: true,
    sources: EXPECTED_SOURCES,
  });
}

async function validateExtractedBundle(extractDir: string): Promise<BackupManifest> {
  const topLevel = (await readdir(extractDir)).sort();
  if (topLevel.join('\n') !== EXPECTED_TOP_LEVEL.join('\n')) {
    throw new Error('Backup archive top-level contents are invalid');
  }
  for (const source of EXPECTED_SOURCES) {
    const info = await lstat(join(extractDir, source));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Backup archive source is not a directory: ${source}`);
    }
  }
  const manifestInfo = await lstat(join(extractDir, 'manifest.json'));
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error('Backup archive manifest is not a regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(extractDir, 'manifest.json'), 'utf8')) as unknown;
  } catch {
    throw new Error('Backup manifest is not valid JSON');
  }
  return parseManifest(parsed);
}

/**
 * Authenticates and structurally verifies a backup without writing production volumes.
 * Plaintext exists only below a temporary 0700 directory and is removed before return/error.
 */
export async function verifyEncryptedBackupBundle(
  input: VerifyEncryptedBackupBundleInput,
): Promise<VerifiedEncryptedBackupBundle> {
  const fileName = basename(input.bundlePath);
  if (!fileName.endsWith('.mdbak') || fileName !== input.bundlePath.split('/').at(-1)) {
    throw new Error('Backup bundle path must identify one .mdbak file');
  }
  const expectedChecksum = parseChecksumFile(await readFile(input.checksumPath, 'utf8'), fileName);
  const actualChecksum = await verifyBackupBundleChecksum(input.bundlePath);
  if (actualChecksum !== expectedChecksum) throw new Error('Backup bundle SHA-256 checksum mismatch');

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'masters-backup-verify-'));
  const tarPath = join(temporaryRoot, 'bundle.tar');
  const extractDir = join(temporaryRoot, 'extract');
  await mkdir(extractDir, { mode: 0o700 });
  try {
    await decryptBackupBundleToTar(input.bundlePath, input.keyFile, tarPath);
    await execFileAsync('tar', ['-xf', tarPath, '-C', extractDir, '--no-same-owner']);
    const manifest = await validateExtractedBundle(extractDir);
    return Object.freeze({ fileName, sha256: actualChecksum, manifest });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
