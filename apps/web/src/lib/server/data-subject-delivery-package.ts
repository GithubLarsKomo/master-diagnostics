import {
  buildAthleteDataSubjectReviewedDeliverySnapshot,
  type Database,
} from '@masters/db';
import {
  DATA_SUBJECT_REVIEWED_DELIVERY_VERSION,
  type AthleteDataSubjectReviewedDeliverySnapshot,
} from '@masters/domain';
import type { ReportArtifactStorage } from '../report-artifact-storage';

export const DATA_SUBJECT_PACKAGE_MANIFEST_VERSION = 'masters-data-subject-package-manifest-v1' as const;

export interface DataSubjectPackageDataFile {
  kind: 'DATA_JSON';
  path: 'data.json';
  mediaType: 'application/json';
  sha256: string;
  byteLength: number;
}

export interface DataSubjectPackageReportFile {
  kind: 'REPORT_PDF';
  path: string;
  mediaType: 'application/pdf';
  reportVersionId: string;
  sha256: string;
  byteLength: number;
}

export type DataSubjectPackageManifestFile = DataSubjectPackageDataFile | DataSubjectPackageReportFile;

export interface DataSubjectPackageManifest {
  version: typeof DATA_SUBJECT_PACKAGE_MANIFEST_VERSION;
  reviewedSnapshotVersion: typeof DATA_SUBJECT_REVIEWED_DELIVERY_VERSION;
  approvalId: string;
  sourceFingerprint: string;
  decisionsFingerprint: string;
  reviewedFingerprint: string;
  files: readonly Readonly<DataSubjectPackageManifestFile>[];
  manifestFingerprint: string;
}

export interface PreparedDataSubjectPackageFile {
  path: string;
  mediaType: 'application/json' | 'application/pdf';
  bytes: Uint8Array;
}

export interface PreparedDataSubjectDeliveryPackage {
  manifest: Readonly<DataSubjectPackageManifest>;
  manifestJson: Uint8Array;
  files: readonly Readonly<PreparedDataSubjectPackageFile>[];
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Manifest fingerprint values require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported manifest fingerprint value type: ${typeof value}`);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 hashing requires the Web Crypto API');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${toHex(digest)}`;
}

async function fingerprint(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalize(value)));
}

function renderReviewedSnapshot(snapshot: Readonly<AthleteDataSubjectReviewedDeliverySnapshot>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(snapshot, null, 2)}\n`);
}

function packageReportPath(index: number): string {
  return `reports/${String(index + 1).padStart(4, '0')}.pdf`;
}

function reportRowById(
  snapshot: Readonly<AthleteDataSubjectReviewedDeliverySnapshot>,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const rows = new Map<string, Readonly<Record<string, unknown>>>();
  for (const row of snapshot.reviewedSource.data.report_versions) {
    if (typeof row.id !== 'string') throw new Error('Report version row is missing an id');
    if (rows.has(row.id)) throw new Error('Duplicate report version id in reviewed source');
    rows.set(row.id, row);
  }
  return rows;
}

/**
 * Builds an in-memory, verified package candidate. Every report byte sequence is
 * hashed and compared with the immutable report_versions content hash before it
 * is admitted to the package. The returned bytes are the same bytes that were
 * verified; a later persistence/download writer must not re-read the reports.
 */
export async function prepareAthleteDataSubjectDeliveryPackage(
  db: Database,
  reportStorage: ReportArtifactStorage,
  tenantId: string,
  athleteId: string,
  approvalId: string,
  validatedAt = new Date().toISOString(),
): Promise<Readonly<PreparedDataSubjectDeliveryPackage>> {
  const snapshot = await buildAthleteDataSubjectReviewedDeliverySnapshot(
    db,
    tenantId,
    athleteId,
    approvalId,
    validatedAt,
  );
  const rows = reportRowById(snapshot);
  const artifacts = [...snapshot.reviewedSource.reportArtifacts]
    .sort((left, right) => left.reportVersionId.localeCompare(right.reportVersionId)
      || left.storageReference.localeCompare(right.storageReference));

  if (artifacts.length !== rows.size) {
    throw new Error('Reviewed report artifact inventory does not match report version rows');
  }

  const dataBytes = renderReviewedSnapshot(snapshot);
  const dataFile: Readonly<PreparedDataSubjectPackageFile> = Object.freeze({
    path: 'data.json',
    mediaType: 'application/json',
    bytes: dataBytes,
  });
  const manifestFiles: DataSubjectPackageManifestFile[] = [{
    kind: 'DATA_JSON',
    path: 'data.json',
    mediaType: 'application/json',
    sha256: await sha256(dataBytes),
    byteLength: dataBytes.byteLength,
  }];
  const preparedFiles: Readonly<PreparedDataSubjectPackageFile>[] = [dataFile];

  for (const [index, artifact] of artifacts.entries()) {
    const row = rows.get(artifact.reportVersionId);
    if (!row) throw new Error('Reviewed report artifact has no matching report version row');
    if (row.storage_reference !== artifact.storageReference) {
      throw new Error('Reviewed report storage reference does not match report version row');
    }
    const expectedHash = row.content_hash;
    if (typeof expectedHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(expectedHash)) {
      throw new Error('Reviewed report version has an invalid content hash');
    }

    const bytes = await reportStorage.get(artifact.storageReference);
    const actualHash = await sha256(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(`Report PDF integrity check failed for ${artifact.reportVersionId}`);
    }

    const path = packageReportPath(index);
    manifestFiles.push({
      kind: 'REPORT_PDF',
      path,
      mediaType: 'application/pdf',
      reportVersionId: artifact.reportVersionId,
      sha256: actualHash,
      byteLength: bytes.byteLength,
    });
    preparedFiles.push(Object.freeze({
      path,
      mediaType: 'application/pdf',
      bytes,
    }));
  }

  const manifestCore = Object.freeze({
    version: DATA_SUBJECT_PACKAGE_MANIFEST_VERSION,
    reviewedSnapshotVersion: DATA_SUBJECT_REVIEWED_DELIVERY_VERSION,
    approvalId: snapshot.approvalId,
    sourceFingerprint: snapshot.sourceFingerprint,
    decisionsFingerprint: snapshot.decisionsFingerprint,
    reviewedFingerprint: snapshot.reviewedFingerprint,
    files: Object.freeze(manifestFiles.map((file) => Object.freeze({ ...file }))),
  });
  const manifestFingerprint = await fingerprint(manifestCore);
  const manifest: Readonly<DataSubjectPackageManifest> = Object.freeze({
    ...manifestCore,
    manifestFingerprint,
  });
  const manifestJson = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

  return Object.freeze({
    manifest,
    manifestJson,
    files: Object.freeze(preparedFiles),
  });
}
