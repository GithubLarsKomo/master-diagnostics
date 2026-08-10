import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { readBackupEncryptionKey, type BackupManifest } from './backup-bundle';

export const RESTORE_SOURCE_PROVENANCE_VERSION = 1 as const;
export const RESTORE_SOURCE_PROVENANCE_ENVELOPE_VERSION = 1 as const;
export const RESTORE_SOURCE_PROVENANCE_FILE_NAME = 'restore-source-provenance.json' as const;

const SIGNING_DOMAIN = 'masters:backup-restore-source-provenance:v1\n';
const HMAC_PREFIX = 'hmac-sha256:';
const HMAC_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STAGING_NAME_PATTERN = /^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUNDLE_NAME_PATTERN = /^masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak$/;

export interface RestoreSourceProvenanceRecord {
  readonly provenanceVersion: typeof RESTORE_SOURCE_PROVENANCE_VERSION;
  readonly stagingName: string;
  readonly backupFileName: string;
  readonly backupSha256: `sha256:${string}`;
  readonly backupCreatedAt: string;
  readonly backupManifestFingerprint: `sha256:${string}`;
  readonly bundleVersion: 1;
  readonly consistency: 'CLEANLY_STOPPED_VOLUMES';
  readonly restoreReconciliationRequired: true;
  readonly sourceNames: readonly string[];
}

export interface SignedRestoreSourceProvenanceEnvelope {
  readonly envelopeVersion: typeof RESTORE_SOURCE_PROVENANCE_ENVELOPE_VERSION;
  readonly record: Readonly<RestoreSourceProvenanceRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Unsupported restore source provenance value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function payload(record: Readonly<RestoreSourceProvenanceRecord>): string {
  return `${SIGNING_DOMAIN}${canonicalJson({ envelopeVersion: RESTORE_SOURCE_PROVENANCE_ENVELOPE_VERSION, record })}`;
}

function sign(key: Buffer, record: Readonly<RestoreSourceProvenanceRecord>): `hmac-sha256:${string}` {
  return `${HMAC_PREFIX}${createHmac('sha256', key).update(payload(record)).digest('hex')}`;
}

function validateRecord(record: Readonly<RestoreSourceProvenanceRecord>): void {
  if (record.provenanceVersion !== 1) throw new Error('Restore source provenance version is invalid');
  if (!STAGING_NAME_PATTERN.test(record.stagingName)) throw new Error('Restore source provenance staging name is invalid');
  if (!BUNDLE_NAME_PATTERN.test(record.backupFileName) || basename(record.backupFileName) !== record.backupFileName) {
    throw new Error('Restore source provenance backup file name is invalid');
  }
  if (!SHA256_PATTERN.test(record.backupSha256)) throw new Error('Restore source provenance backup SHA-256 is invalid');
  if (!Number.isFinite(Date.parse(record.backupCreatedAt))) throw new Error('Restore source provenance backup createdAt is invalid');
  if (!SHA256_PATTERN.test(record.backupManifestFingerprint)) throw new Error('Restore source provenance manifest fingerprint is invalid');
  if (record.bundleVersion !== 1 || record.consistency !== 'CLEANLY_STOPPED_VOLUMES' || record.restoreReconciliationRequired !== true) {
    throw new Error('Restore source provenance backup policy is invalid');
  }
  const expectedSources = ['libsql', 'reports', 'tenant-exports', 'data-subject-delivery', 'caddy-data', 'caddy-config'];
  if (JSON.stringify(record.sourceNames) !== JSON.stringify(expectedSources)) {
    throw new Error('Restore source provenance source set is invalid');
  }
}

export function createRestoreSourceProvenanceRecord(input: Readonly<{
  stagingName: string;
  backupFileName: string;
  backupSha256: string;
  manifest: Readonly<BackupManifest>;
}>): Readonly<RestoreSourceProvenanceRecord> {
  const record = Object.freeze({
    provenanceVersion: 1 as const,
    stagingName: input.stagingName,
    backupFileName: input.backupFileName,
    backupSha256: input.backupSha256 as `sha256:${string}`,
    backupCreatedAt: input.manifest.createdAt,
    backupManifestFingerprint: sha256(canonicalJson(input.manifest)),
    bundleVersion: input.manifest.bundleVersion,
    consistency: input.manifest.consistency,
    restoreReconciliationRequired: input.manifest.restoreReconciliationRequired,
    sourceNames: Object.freeze([...input.manifest.sources]),
  });
  validateRecord(record);
  return record;
}

export async function persistSignedRestoreSourceProvenance(input: Readonly<{
  stagingPath: string;
  keyFile: string;
  record: Readonly<RestoreSourceProvenanceRecord>;
}>): Promise<Readonly<{ path: string; envelope: SignedRestoreSourceProvenanceEnvelope }>> {
  if (!isAbsolute(input.stagingPath)) throw new Error('Restore source provenance staging path must be absolute');
  const stat = await lstat(input.stagingPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore source provenance staging path must be a non-symlink directory');
  validateRecord(input.record);
  const key = await readBackupEncryptionKey(input.keyFile);
  const envelope = Object.freeze({
    envelopeVersion: 1 as const,
    record: input.record,
    signature: sign(key, input.record),
  }) satisfies SignedRestoreSourceProvenanceEnvelope;
  const path = join(input.stagingPath, RESTORE_SOURCE_PROVENANCE_FILE_NAME);
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
  return Object.freeze({ path, envelope });
}

export async function readVerifiedRestoreSourceProvenance(filePath: string, keyFile: string): Promise<Readonly<SignedRestoreSourceProvenanceEnvelope>> {
  if (!isAbsolute(filePath) || basename(filePath) !== RESTORE_SOURCE_PROVENANCE_FILE_NAME) {
    throw new Error('Restore source provenance file path is invalid');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore source provenance must be a regular non-symlink file');
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestoreSourceProvenanceEnvelope>;
  if (parsed.envelopeVersion !== 1 || !parsed.record || typeof parsed.signature !== 'string' || !HMAC_PATTERN.test(parsed.signature)) {
    throw new Error('Restore source provenance envelope is invalid');
  }
  validateRecord(parsed.record);
  const key = await readBackupEncryptionKey(keyFile);
  const expected = sign(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(HMAC_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(HMAC_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore source provenance signature verification failed');
  }
  return Object.freeze({ envelopeVersion: 1, record: parsed.record, signature: parsed.signature as `hmac-sha256:${string}` });
}
