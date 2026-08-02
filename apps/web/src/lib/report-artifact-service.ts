import { appendReportVersion, type Database, type StoredReportVersion } from '@masters/db';
import { renderReportPdf, type ReportDocument, type ReportLocale } from '@masters/domain';
import type { ReportArtifactStorage } from './report-artifact-storage';

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashBytes(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${hex(digest)}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export interface PersistReportArtifactInput {
  tenantId: string;
  testId: string;
  interpretationId: string;
  locale: ReportLocale;
  document: ReportDocument;
}

/**
 * Renders and persists one immutable report artifact before appending its DB version row.
 * The storage reference is content-addressed so retries cannot overwrite different bytes.
 */
export async function persistReportArtifactVersion(
  db: Database,
  storage: ReportArtifactStorage,
  input: PersistReportArtifactInput,
): Promise<StoredReportVersion> {
  if (input.document.locale !== input.locale) {
    throw new Error('Report document locale does not match requested locale');
  }

  const bytes = renderReportPdf(input.document);
  const contentHash = await hashBytes(bytes);
  const digest = contentHash.slice('sha256:'.length);
  const storageReference = `${input.tenantId}/${input.testId}/${input.locale}/${digest}.pdf`;

  try {
    await storage.put(storageReference, bytes);
  } catch (error) {
    // Content-addressed retries are safe only when the already stored bytes are identical.
    try {
      const existing = await storage.get(storageReference);
      if (!equalBytes(existing, bytes)) throw error;
    } catch {
      throw error;
    }
  }

  return appendReportVersion(db, input.tenantId, input.testId, {
    interpretationId: input.interpretationId,
    locale: input.locale,
    contentHash,
    storageReference,
  });
}

/** Reads a persisted report artifact and verifies its SHA-256 integrity before returning bytes. */
export async function readVerifiedReportArtifact(
  storage: ReportArtifactStorage,
  version: Pick<StoredReportVersion, 'contentHash' | 'storageReference'>,
): Promise<Uint8Array> {
  const bytes = await storage.get(version.storageReference);
  const actualHash = await hashBytes(bytes);
  if (actualHash !== version.contentHash) {
    throw new Error('Report artifact integrity verification failed');
  }
  return bytes;
}
