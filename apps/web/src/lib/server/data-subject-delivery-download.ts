import {
  consumeAthleteDataSubjectDeliveryPackage,
  getAvailableAthleteDataSubjectDeliveryPackage,
  type Database,
} from '@masters/db';
import type { DataSubjectDeliveryPackageStorage } from '../data-subject-delivery-package-storage';
import {
  decryptDataSubjectDeliveryArchive,
  hashDataSubjectDeliveryToken,
} from './data-subject-delivery-package-writer';

export interface DataSubjectDeliveryDownloadDependencies {
  db: Database;
  packageStorage: DataSubjectDeliveryPackageStorage;
  now?: () => string;
}

export interface DataSubjectDeliveryDownload {
  packageId: string;
  tenantId: string;
  athleteId: string;
  fileName: string;
  mediaType: 'application/x-tar';
  bytes: Uint8Array;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 hashing requires the Web Crypto API');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', arrayBuffer(bytes));
  return `sha256:${toHex(digest)}`;
}

/**
 * Resolves a bearer token into one TAR download exactly once. Integrity and
 * AES-GCM authentication happen before DB consumption. The TAR bytes are only
 * returned if the final compare-and-set consumption succeeds, so concurrent
 * callers cannot both obtain a successful download result.
 */
export async function consumeDataSubjectDeliveryDownload(
  deps: DataSubjectDeliveryDownloadDependencies,
  token: string,
): Promise<Readonly<DataSubjectDeliveryDownload> | null> {
  if (!token || token.length > 512) return null;
  const now = deps.now ?? (() => new Date().toISOString());
  const downloadedAt = now();
  if (!Number.isFinite(Date.parse(downloadedAt))) throw new Error('Download time must be a valid ISO-8601 timestamp');

  const tokenHash = await hashDataSubjectDeliveryToken(token);
  const available = await getAvailableAthleteDataSubjectDeliveryPackage(
    deps.db,
    tokenHash,
    downloadedAt,
  );
  if (!available) return null;

  const encrypted = await deps.packageStorage.get(available.storageReference);
  const actualPackageHash = await sha256(encrypted);
  if (actualPackageHash !== available.packageSha256) {
    throw new Error('Data subject delivery package integrity check failed');
  }

  const archive = await decryptDataSubjectDeliveryArchive(
    encrypted,
    token,
    available.id,
    available.manifestFingerprint,
  );

  const consumed = await consumeAthleteDataSubjectDeliveryPackage(
    deps.db,
    tokenHash,
    downloadedAt,
  );
  if (!consumed) return null;
  if (consumed.id !== available.id
    || consumed.tenantId !== available.tenantId
    || consumed.athleteId !== available.athleteId
    || consumed.manifestFingerprint !== available.manifestFingerprint
    || consumed.packageSha256 !== available.packageSha256) {
    throw new Error('Consumed data subject delivery package no longer matches verified package');
  }

  return Object.freeze({
    packageId: consumed.id,
    tenantId: consumed.tenantId,
    athleteId: consumed.athleteId,
    fileName: `masters-data-subject-export-${consumed.id}.tar`,
    mediaType: 'application/x-tar',
    bytes: archive,
  });
}
