import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BACKUP_MAGIC = Buffer.from('MDBACKUP1', 'ascii');
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const REQUIRED_SOURCE_NAMES = Object.freeze([
  'libsql',
  'reports',
  'tenant-exports',
  'data-subject-delivery',
  'caddy-data',
  'caddy-config',
] as const);

export const BACKUP_BUNDLE_VERSION = 1;
export type BackupSourceName = typeof REQUIRED_SOURCE_NAMES[number];

export interface BackupManifest {
  readonly bundleVersion: 1;
  readonly createdAt: string;
  readonly consistency: 'CLEANLY_STOPPED_VOLUMES';
  readonly encryption: 'AES-256-GCM';
  readonly restoreReconciliationRequired: true;
  readonly sources: readonly BackupSourceName[];
}

export interface CreateEncryptedBackupBundleInput {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly keyFile: string;
  readonly createdAt?: string;
}

export interface CreatedEncryptedBackupBundle {
  readonly fileName: string;
  readonly outputPath: string;
  readonly checksumPath: string;
  readonly sha256: string;
  readonly createdAt: string;
  readonly manifest: BackupManifest;
}

function assertIsoTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Backup creation time must be a valid ISO-8601 timestamp');
}

function timestampSegment(value: string): string {
  return value.replace(/[-:.]/g, '');
}

export async function readBackupEncryptionKey(keyFile: string): Promise<Buffer> {
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  if (!encoded) throw new Error('Backup encryption key file is empty');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Backup encryption key must decode to exactly 32 bytes');
  return key;
}

async function assertBackupSources(sourceDir: string): Promise<void> {
  for (const name of REQUIRED_SOURCE_NAMES) {
    const info = await lstat(join(sourceDir, name)).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Backup source directory is missing: ${name}`);
  }
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  label: string,
): Promise<void> {
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
  if (bytesRead !== buffer.length) throw new Error(`Backup bundle ${label} is truncated`);
}

async function waitForChild(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}`);
  }
}

function hashingTransform(hash: ReturnType<typeof createHash>, cipher: CipherGCM) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      try {
        const tag = cipher.getAuthTag();
        hash.update(tag);
        this.push(tag);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

/**
 * Creates one encrypted full-volume backup bundle.
 *
 * The caller must stop every service capable of writing the mounted source volumes before calling
 * this function. The tar stream is encrypted directly into the target file; no plaintext archive
 * is written to the target medium.
 */
export async function createEncryptedBackupBundle(
  input: CreateEncryptedBackupBundleInput,
): Promise<CreatedEncryptedBackupBundle> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertIsoTimestamp(createdAt);
  await assertBackupSources(input.sourceDir);
  await mkdir(input.targetDir, { recursive: true });
  const key = await readBackupEncryptionKey(input.keyFile);

  const manifest: BackupManifest = Object.freeze({
    bundleVersion: BACKUP_BUNDLE_VERSION,
    createdAt,
    consistency: 'CLEANLY_STOPPED_VOLUMES',
    encryption: 'AES-256-GCM',
    restoreReconciliationRequired: true,
    sources: REQUIRED_SOURCE_NAMES,
  });
  const manifestPath = join(input.sourceDir, 'manifest.json');
  const fileName = `masters-backup-${timestampSegment(createdAt)}-${randomUUID()}.mdbak`;
  const outputPath = join(input.targetDir, fileName);
  const checksumPath = `${outputPath}.sha256`;
  const iv = randomBytes(IV_LENGTH);
  const header = Buffer.concat([BACKUP_MAGIC, iv]);
  const hash = createHash('sha256');
  const cipher = createCipheriv(
    'aes-256-gcm',
    key,
    iv,
    { authTagLength: AUTH_TAG_LENGTH },
  ) as CipherGCM;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const tar = spawn('tar', [
    '-C', input.sourceDir,
    '-cf', '-',
    'manifest.json',
    ...REQUIRED_SOURCE_NAMES,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  tar.stderr.setEncoding('utf8');
  tar.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  try {
    hash.update(header);
    if (!output.write(header)) await once(output, 'drain');
    await Promise.all([
      pipeline(tar.stdout, cipher, hashingTransform(hash, cipher), output),
      waitForChild(tar, 'Backup tar stream'),
    ]);
    const sha256 = hash.digest('hex');
    await writeFile(checksumPath, `${sha256}  ${fileName}\n`, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ fileName, outputPath, checksumPath, sha256, createdAt, manifest });
  } catch (error) {
    tar.kill('SIGKILL');
    await Promise.allSettled([rm(outputPath, { force: true }), rm(checksumPath, { force: true })]);
    const detail = stderr.trim();
    if (detail) throw new Error(`Backup bundle creation failed: ${detail}`, { cause: error });
    throw error;
  } finally {
    await rm(manifestPath, { force: true });
  }
}

/** Decrypts a bundle into a temporary tar path for verification/restore workflows. */
export async function decryptBackupBundleToTar(
  bundlePath: string,
  keyFile: string,
  outputTarPath: string,
): Promise<void> {
  const key = await readBackupEncryptionKey(keyFile);
  const info = await stat(bundlePath);
  const minimumSize = BACKUP_MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH + 1;
  if (info.size < minimumSize) throw new Error('Backup bundle is truncated');

  const handle = await open(bundlePath, 'r');
  try {
    const header = Buffer.alloc(BACKUP_MAGIC.length + IV_LENGTH);
    await readExactly(handle, header, 0, 'header');
    if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
      throw new Error('Backup bundle magic/version is invalid');
    }
    const iv = header.subarray(BACKUP_MAGIC.length);
    const authTag = Buffer.alloc(AUTH_TAG_LENGTH);
    await readExactly(handle, authTag, info.size - AUTH_TAG_LENGTH, 'authentication tag');

    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      iv,
      { authTagLength: AUTH_TAG_LENGTH },
    ) as DecipherGCM;
    decipher.setAuthTag(authTag);
    const encryptedStart = header.length;
    const encryptedEnd = info.size - AUTH_TAG_LENGTH - 1;
    await pipeline(
      createReadStream(bundlePath, { start: encryptedStart, end: encryptedEnd }),
      decipher,
      createWriteStream(outputTarPath, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    await rm(outputTarPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

export async function verifyBackupBundleChecksum(bundlePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(bundlePath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest('hex');
}

export function backupChecksumFileName(bundlePath: string): string {
  return `${basename(bundlePath)}.sha256`;
}
