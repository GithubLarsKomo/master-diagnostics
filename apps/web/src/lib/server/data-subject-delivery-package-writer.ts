import { Buffer } from 'node:buffer';
import {
  createAthleteDataSubjectDeliveryPackageRecord,
  type AuditActorContext,
  type Database,
  type StoredAthleteDataSubjectDeliveryPackage,
} from '@masters/db';
import type { ReportArtifactStorage } from '../report-artifact-storage';
import type { DataSubjectDeliveryPackageStorage } from '../data-subject-delivery-package-storage';
import { prepareAthleteDataSubjectDeliveryPackage } from './data-subject-delivery-package';

export const DATA_SUBJECT_DELIVERY_ARCHIVE_VERSION = 1 as const;
export const DATA_SUBJECT_DELIVERY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DATA_SUBJECT_DELIVERY_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DataSubjectDeliveryPackageWriterDependencies {
  db: Database;
  reportStorage: ReportArtifactStorage;
  packageStorage: DataSubjectDeliveryPackageStorage;
  now?: () => string;
}

export interface CreateDataSubjectDeliveryPackageInput {
  tenantId: string;
  athleteId: string;
  approvalId: string;
  actor: AuditActorContext;
  ttlMs?: number;
}

export interface CreatedDataSubjectDeliveryPackage {
  record: Readonly<StoredAthleteDataSubjectDeliveryPackage>;
  token: string;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error(`TAR field exceeds ${length} bytes`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('TAR numeric field must be a non-negative safe integer');
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error('TAR numeric field overflow');
  writeAscii(target, offset, length - 1, octal.padStart(length - 1, '0'));
  target[offset + length - 1] = 0;
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumOctal = checksum.toString(8).padStart(6, '0');
  writeAscii(header, 148, 6, checksumOctal);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function buildDeterministicDataSubjectTar(
  manifestJson: Uint8Array,
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
): Uint8Array {
  const entries = [
    { path: 'manifest.json', bytes: manifestJson },
    ...files.map((file) => ({ path: file.path, bytes: file.bytes })),
  ];
  const paths = new Set<string>();
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._/-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.includes('..')) {
      throw new Error('Unsafe data subject TAR path');
    }
    if (paths.has(entry.path)) throw new Error('Duplicate data subject TAR path');
    paths.add(entry.path);
    chunks.push(tarHeader(entry.path, entry.bytes.byteLength));
    chunks.push(new Uint8Array(entry.bytes));
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concat(chunks);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 hashing requires the Web Crypto API');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${toHex(digest)}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64url');
}

async function deriveEncryptionKey(token: string): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`masters-data-subject-package-key-v1\u0000${token}`),
  );
  return globalThis.crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt']);
}

async function encryptArchive(
  archive: Uint8Array,
  token: string,
  packageId: string,
  manifestFingerprint: string,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(token);
  const additionalData = new TextEncoder().encode(
    `masters-data-subject-package-v1\u0000${packageId}\u0000${manifestFingerprint}`,
  );
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    archive,
  ));
  return concat([new TextEncoder().encode('MDS1'), iv, ciphertext]);
}

/**
 * Persists a verified subject delivery package as an encrypted private artifact.
 * The bearer token is returned only to the caller. The DB stores only its SHA-256
 * hash, while the encryption key is derived from the token and is never stored.
 */
export async function createDataSubjectDeliveryPackage(
  deps: DataSubjectDeliveryPackageWriterDependencies,
  input: CreateDataSubjectDeliveryPackageInput,
): Promise<Readonly<CreatedDataSubjectDeliveryPackage>> {
  if (input.actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  const now = deps.now ?? (() => new Date().toISOString());
  const createdAt = now();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Package creation time must be a valid ISO-8601 timestamp');
  const ttlMs = input.ttlMs ?? DATA_SUBJECT_DELIVERY_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DATA_SUBJECT_DELIVERY_MAX_TTL_MS) {
    throw new Error('Data subject delivery package TTL must be greater than zero and at most seven days');
  }
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();

  const prepared = await prepareAthleteDataSubjectDeliveryPackage(
    deps.db,
    deps.reportStorage,
    input.tenantId,
    input.athleteId,
    input.approvalId,
    createdAt,
  );
  const archive = buildDeterministicDataSubjectTar(prepared.manifestJson, prepared.files);
  const packageId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256(new TextEncoder().encode(token));
  const encrypted = await encryptArchive(
    archive,
    token,
    packageId,
    prepared.manifest.manifestFingerprint,
  );
  const packageSha256 = await sha256(encrypted);
  const storageReference = `${packageId}.mdse`;

  await deps.packageStorage.put(storageReference, encrypted);
  try {
    const record = await createAthleteDataSubjectDeliveryPackageRecord(deps.db, {
      id: packageId,
      tenantId: input.tenantId,
      athleteId: input.athleteId,
      approvalId: input.approvalId,
      manifestFingerprint: prepared.manifest.manifestFingerprint,
      tokenHash,
      storageReference,
      packageSha256,
      actor: input.actor,
      expiresAt,
      createdAt,
    });
    return Object.freeze({ record, token });
  } catch (databaseError) {
    try {
      await deps.packageStorage.remove(storageReference);
    } catch (storageCleanupError) {
      throw new AggregateError(
        [databaseError, storageCleanupError],
        'Data subject package metadata creation failed and encrypted artifact cleanup was incomplete',
      );
    }
    throw databaseError;
  }
}
