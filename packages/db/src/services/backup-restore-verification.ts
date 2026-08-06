import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const EXPECTED_TOP_LEVEL = new Set<string>(['manifest.json', ...EXPECTED_SOURCES]);

export interface VerifyEncryptedBackupBundleInput {
  readonly bundlePath: string;
  readonly checksumPath: string;
  readonly keyFile: string;
}

export interface VerifiedEncryptedBackupBundle {
  readonly fileName: string;
  readonly sha256: string;
  readonly manifest: BackupManifest;
  readonly archiveEntryCount: number;
}

function parseChecksumFile(content: string, expectedFileName: string): string {
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/.exec(content);
  if (!match) throw new Error('Backup checksum file format is invalid');
  const checksum = match[1];
  const fileName = match[2];
  if (!checksum || !fileName) throw new Error('Backup checksum file format is invalid');
  if (fileName !== expectedFileName) throw new Error('Backup checksum file names a different bundle');
  return checksum;
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backup manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.bundleVersion !== BACKUP_BUNDLE_VERSION) throw new Error('Backup manifest version is unsupported');
  const createdAt = manifest.createdAt;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Backup manifest creation time is invalid');
  }
  if (manifest.consistency !== 'CLEANLY_STOPPED_VOLUMES') throw new Error('Backup consistency mode is unsupported');
  if (manifest.encryption !== 'AES-256-GCM') throw new Error('Backup encryption mode is unsupported');
  if (manifest.restoreReconciliationRequired !== true) {
    throw new Error('Backup manifest must require restore privacy reconciliation');
  }
  const sources = manifest.sources;
  if (!Array.isArray(sources) || sources.length !== EXPECTED_SOURCES.length) {
    throw new Error('Backup manifest source set is invalid');
  }
  if (!EXPECTED_SOURCES.every((source, index) => sources[index] === source)) {
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
    createdAt,
    consistency: 'CLEANLY_STOPPED_VOLUMES',
    encryption: 'AES-256-GCM',
    restoreReconciliationRequired: true,
    sources: EXPECTED_SOURCES,
  });
}

function validateArchiveEntries(stdout: string): readonly string[] {
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error('Backup archive is empty');
  const topLevel = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')) {
      throw new Error('Backup archive contains an unsafe path');
    }
    const normalized = entry.replace(/\/+$/, '');
    const [root] = normalized.split('/');
    if (!root || !EXPECTED_TOP_LEVEL.has(root)) {
      throw new Error('Backup archive contains an unsupported top-level entry');
    }
    topLevel.add(root);
  }
  if (topLevel.size !== EXPECTED_TOP_LEVEL.size
    || [...EXPECTED_TOP_LEVEL].some((entry) => !topLevel.has(entry))) {
    throw new Error('Backup archive is missing required top-level entries');
  }
  return Object.freeze(entries);
}

/**
 * Authenticates and structurally verifies a backup without writing production volumes.
 * Plaintext exists only as one temporary 0600 tar below a private temporary directory and is
 * removed before return/error; the contained data files are never extracted during verification.
 */
export async function verifyEncryptedBackupBundle(
  input: VerifyEncryptedBackupBundleInput,
): Promise<VerifiedEncryptedBackupBundle> {
  const fileName = basename(input.bundlePath);
  if (!fileName.endsWith('.mdbak')) throw new Error('Backup bundle must use the .mdbak extension');

  const expectedChecksum = parseChecksumFile(await readFile(input.checksumPath, 'utf8'), fileName);
  const actualChecksum = await verifyBackupBundleChecksum(input.bundlePath);
  if (actualChecksum !== expectedChecksum) throw new Error('Backup bundle SHA-256 checksum mismatch');

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'masters-backup-verify-'));
  const tarPath = join(temporaryRoot, 'bundle.tar');
  try {
    await decryptBackupBundleToTar(input.bundlePath, input.keyFile, tarPath);
    const listed = await execFileAsync('tar', ['-tf', tarPath], { maxBuffer: 16 * 1024 * 1024 });
    const entries = validateArchiveEntries(listed.stdout);
    const manifestOutput = await execFileAsync('tar', ['-xOf', tarPath, 'manifest.json'], { maxBuffer: 1024 * 1024 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestOutput.stdout) as unknown;
    } catch {
      throw new Error('Backup manifest is not valid JSON');
    }
    const manifest = parseManifest(parsed);
    return Object.freeze({
      fileName,
      sha256: actualChecksum,
      manifest,
      archiveEntryCount: entries.length,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
