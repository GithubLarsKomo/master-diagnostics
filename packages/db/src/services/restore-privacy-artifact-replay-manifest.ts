import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteDataSubjectDeliveryPackages,
  reportVersions,
  tenantExportPackages,
  tests,
} from '../schema';
import type {
  RestorePrivacyReconciliationReport,
  RestorePrivacyReplayObligation,
} from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION = 1 as const;

export type RestorePrivacyArtifactKind = 'REPORT' | 'TENANT_EXPORT' | 'DATA_SUBJECT_DELIVERY';

export interface RestorePrivacyArtifactReplayEntry {
  readonly kind: RestorePrivacyArtifactKind;
  readonly tenantId: string;
  readonly athleteId: string | null;
  readonly storageReference: string;
  readonly executionIds: readonly string[];
}

export interface RestorePrivacyArtifactReplayManifest {
  readonly manifestVersion: typeof RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION;
  readonly backupCutoff: string;
  readonly reconciliationStatus: 'CLEAR' | 'REPLAY_REQUIRED';
  readonly ledgerGeneratedAt: string | null;
  readonly ledgerEntriesFingerprint: string | null;
  readonly journalMarkerCount: number;
  readonly obligationCount: number;
  readonly obligationsFingerprint: `sha256:${string}`;
  readonly entryCount: number;
  readonly entriesFingerprint: `sha256:${string}`;
  readonly entries: readonly Readonly<RestorePrivacyArtifactReplayEntry>[];
}

export interface PersistedRestorePrivacyArtifactReplayManifest {
  readonly created: boolean;
  readonly manifest: Readonly<RestorePrivacyArtifactReplayManifest>;
}

const REPORT_REFERENCE = /^[a-zA-Z0-9/_-]+\.pdf$/;
const TENANT_EXPORT_REFERENCE = /^[a-f0-9-]+\.mde$/;
const DATA_SUBJECT_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function obligationSortKey(item: Readonly<RestorePrivacyReplayObligation>): string {
  return [item.tenantId, item.athleteId, item.executionId, item.dbCommittedAt].join('\n');
}

function canonicalObligations(obligations: readonly Readonly<RestorePrivacyReplayObligation>[]) {
  return [...obligations]
    .sort((left, right) => obligationSortKey(left).localeCompare(obligationSortKey(right)))
    .map((item) => ({
      tenantId: item.tenantId,
      athleteId: item.athleteId,
      executionId: item.executionId,
      approvalId: item.approvalId,
      deletionRequestId: item.deletionRequestId,
      executionVersion: item.executionVersion,
      policyVersion: item.policyVersion,
      scopeFingerprint: item.scopeFingerprint,
      capabilityFingerprint: item.capabilityFingerprint,
      dbCommittedAt: item.dbCommittedAt,
      sources: [...item.sources].sort(),
    }));
}

export function restorePrivacyObligationsFingerprint(
  obligations: readonly Readonly<RestorePrivacyReplayObligation>[],
): `sha256:${string}` {
  return sha256(JSON.stringify(canonicalObligations(obligations)));
}

function assertSafeReportReference(reference: string, tenantId: string, testId?: string): void {
  const expectedPrefix = testId ? `${tenantId}/${testId}/` : `${tenantId}/`;
  if (
    !REPORT_REFERENCE.test(reference)
    || reference.startsWith('/')
    || reference.includes('..')
    || !reference.startsWith(expectedPrefix)
  ) {
    throw new Error('Restore privacy report storage reference is unsafe or outside its subject scope');
  }
}

function assertSafeTenantExportReference(reference: string): void {
  if (!TENANT_EXPORT_REFERENCE.test(reference) || reference.startsWith('/') || reference.includes('..')) {
    throw new Error('Restore privacy tenant export storage reference is unsafe');
  }
}

function assertSafeDataSubjectReference(reference: string): void {
  if (!DATA_SUBJECT_REFERENCE.test(reference) || reference.startsWith('/') || reference.includes('..')) {
    throw new Error('Restore privacy data subject delivery storage reference is unsafe');
  }
}

function entryKey(entry: Readonly<RestorePrivacyArtifactReplayEntry>): string {
  return [entry.kind, entry.tenantId, entry.athleteId ?? '', entry.storageReference].join('\n');
}

function mergeEntry(
  entries: Map<string, RestorePrivacyArtifactReplayEntry>,
  entry: Readonly<RestorePrivacyArtifactReplayEntry>,
): void {
  const key = entryKey(entry);
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, Object.freeze({
      ...entry,
      executionIds: Object.freeze([...new Set(entry.executionIds)].sort()),
    }));
    return;
  }
  entries.set(key, Object.freeze({
    ...existing,
    executionIds: Object.freeze([...new Set([...existing.executionIds, ...entry.executionIds])].sort()),
  }));
}

function pairKey(tenantId: string, athleteId: string): string {
  return `${tenantId}\u0000${athleteId}`;
}

function assertManifestEntry(
  entry: Readonly<RestorePrivacyArtifactReplayEntry>,
  obligationsByExecution: ReadonlyMap<string, Readonly<RestorePrivacyReplayObligation>>,
): void {
  if (!entry.tenantId?.trim() || !entry.storageReference?.trim()) {
    throw new Error('Restore privacy artifact replay manifest entry is incomplete');
  }
  if (!Array.isArray(entry.executionIds) || entry.executionIds.length === 0) {
    throw new Error('Restore privacy artifact replay manifest entry has no bound execution');
  }
  const canonicalExecutionIds = [...new Set(entry.executionIds)].sort();
  if (JSON.stringify(canonicalExecutionIds) !== JSON.stringify(entry.executionIds)) {
    throw new Error('Restore privacy artifact replay manifest execution IDs are not canonical');
  }

  for (const executionId of entry.executionIds) {
    const obligation = obligationsByExecution.get(executionId);
    if (!obligation) throw new Error('Restore privacy artifact replay manifest references an unknown execution');
    if (obligation.tenantId !== entry.tenantId) {
      throw new Error('Restore privacy artifact replay manifest entry crosses tenant scope');
    }
    if (entry.kind !== 'TENANT_EXPORT' && obligation.athleteId !== entry.athleteId) {
      throw new Error('Restore privacy artifact replay manifest entry crosses athlete scope');
    }
  }

  if (entry.kind === 'REPORT') {
    if (!entry.athleteId) throw new Error('Restore privacy report replay entry requires an athlete scope');
    assertSafeReportReference(entry.storageReference, entry.tenantId);
    return;
  }
  if (entry.kind === 'DATA_SUBJECT_DELIVERY') {
    if (!entry.athleteId) throw new Error('Restore privacy data subject replay entry requires an athlete scope');
    assertSafeDataSubjectReference(entry.storageReference);
    return;
  }
  if (entry.kind === 'TENANT_EXPORT') {
    if (entry.athleteId !== null) throw new Error('Restore privacy tenant export replay entry must be tenant-scoped');
    assertSafeTenantExportReference(entry.storageReference);
    return;
  }
  throw new Error('Restore privacy artifact replay manifest entry kind is unsupported');
}

export function verifyRestorePrivacyArtifactReplayManifest(
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
  report: Readonly<RestorePrivacyReconciliationReport>,
): void {
  if (report.status === 'BLOCKED') {
    throw new Error('Restore privacy artifact replay manifest cannot be verified against blocked reconciliation');
  }
  if (manifest.manifestVersion !== RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION) {
    throw new Error('Restore privacy artifact replay manifest version is unsupported');
  }
  if (manifest.backupCutoff !== report.backupCutoff || manifest.reconciliationStatus !== report.status) {
    throw new Error('Restore privacy artifact replay manifest does not match the selected reconciliation');
  }
  if (
    manifest.ledgerGeneratedAt !== (report.ledger?.generatedAt ?? null)
    || manifest.ledgerEntriesFingerprint !== (report.ledger?.entriesFingerprint ?? null)
    || manifest.journalMarkerCount !== report.journalMarkerCount
    || manifest.obligationCount !== report.obligations.length
    || manifest.obligationsFingerprint !== restorePrivacyObligationsFingerprint(report.obligations)
  ) {
    throw new Error('Restore privacy artifact replay manifest evidence binding does not match reconciliation');
  }
  if (!SHA256_FINGERPRINT.test(manifest.obligationsFingerprint) || !SHA256_FINGERPRINT.test(manifest.entriesFingerprint)) {
    throw new Error('Restore privacy artifact replay manifest fingerprint is invalid');
  }
  if (!Array.isArray(manifest.entries) || manifest.entryCount !== manifest.entries.length) {
    throw new Error('Restore privacy artifact replay manifest entry count is invalid');
  }
  if (report.status === 'CLEAR' && manifest.entries.length !== 0) {
    throw new Error('CLEAR restore privacy reconciliation must have an empty artifact replay plan');
  }

  const obligationsByExecution = new Map(report.obligations.map((item) => [item.executionId, item] as const));
  for (const entry of manifest.entries) assertManifestEntry(entry, obligationsByExecution);
  const canonicalEntries = [...manifest.entries].sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  if (JSON.stringify(canonicalEntries) !== JSON.stringify(manifest.entries)) {
    throw new Error('Restore privacy artifact replay manifest entries are not in canonical order');
  }
  if (new Set(manifest.entries.map((entry) => entryKey(entry))).size !== manifest.entries.length) {
    throw new Error('Restore privacy artifact replay manifest contains duplicate entries');
  }
  if (sha256(JSON.stringify(manifest.entries)) !== manifest.entriesFingerprint) {
    throw new Error('Restore privacy artifact replay manifest entries fingerprint does not match its entries');
  }
}

/**
 * Captures every file reference that a later restore-artifact replay must remove before the
 * database replay erases the corresponding metadata. The output is deterministic and technical-only.
 */
export async function buildRestorePrivacyArtifactReplayManifest(
  db: Database,
  report: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<RestorePrivacyArtifactReplayManifest>> {
  if (report.status === 'BLOCKED') {
    throw new Error('Restore privacy artifact replay manifest cannot be created from a blocked reconciliation');
  }

  const entries = new Map<string, RestorePrivacyArtifactReplayEntry>();
  const obligationsBySubject = new Map<string, Readonly<{
    tenantId: string;
    athleteId: string;
    executionIds: readonly string[];
  }>>();
  const executionIdsByTenant = new Map<string, readonly string[]>();

  for (const obligation of report.obligations) {
    const subjectKey = pairKey(obligation.tenantId, obligation.athleteId);
    const subject = obligationsBySubject.get(subjectKey);
    obligationsBySubject.set(subjectKey, Object.freeze({
      tenantId: obligation.tenantId,
      athleteId: obligation.athleteId,
      executionIds: Object.freeze([
        ...new Set([...(subject?.executionIds ?? []), obligation.executionId]),
      ].sort()),
    }));
    executionIdsByTenant.set(obligation.tenantId, Object.freeze([
      ...new Set([...(executionIdsByTenant.get(obligation.tenantId) ?? []), obligation.executionId]),
    ].sort()));
  }

  for (const subject of [...obligationsBySubject.values()].sort((left, right) => (
    pairKey(left.tenantId, left.athleteId).localeCompare(pairKey(right.tenantId, right.athleteId))
  ))) {
    const testRows = await db.select({ id: tests.id }).from(tests).where(and(
      eq(tests.tenantId, subject.tenantId),
      eq(tests.athleteId, subject.athleteId),
    ));
    const testIds = testRows.map((row) => row.id).sort();
    if (testIds.length > 0) {
      const reports = await db.select({
        testId: reportVersions.testId,
        storageReference: reportVersions.storageReference,
      }).from(reportVersions).where(and(
        eq(reportVersions.tenantId, subject.tenantId),
        inArray(reportVersions.testId, testIds),
      ));
      for (const artifact of reports) {
        assertSafeReportReference(artifact.storageReference, subject.tenantId, artifact.testId);
        mergeEntry(entries, {
          kind: 'REPORT',
          tenantId: subject.tenantId,
          athleteId: subject.athleteId,
          storageReference: artifact.storageReference,
          executionIds: subject.executionIds,
        });
      }
    }

    const deliveryPackages = await db.select({
      storageReference: athleteDataSubjectDeliveryPackages.storageReference,
    }).from(athleteDataSubjectDeliveryPackages).where(and(
      eq(athleteDataSubjectDeliveryPackages.tenantId, subject.tenantId),
      eq(athleteDataSubjectDeliveryPackages.athleteId, subject.athleteId),
    ));
    for (const artifact of deliveryPackages) {
      assertSafeDataSubjectReference(artifact.storageReference);
      mergeEntry(entries, {
        kind: 'DATA_SUBJECT_DELIVERY',
        tenantId: subject.tenantId,
        athleteId: subject.athleteId,
        storageReference: artifact.storageReference,
        executionIds: subject.executionIds,
      });
    }
  }

  for (const [tenantId, executionIds] of [...executionIdsByTenant.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const exports = await db.select({
      storageReference: tenantExportPackages.storageReference,
    }).from(tenantExportPackages).where(eq(tenantExportPackages.tenantId, tenantId));
    for (const artifact of exports) {
      assertSafeTenantExportReference(artifact.storageReference);
      mergeEntry(entries, {
        kind: 'TENANT_EXPORT',
        tenantId,
        athleteId: null,
        storageReference: artifact.storageReference,
        executionIds,
      });
    }
  }

  const canonicalEntries = Object.freeze(
    [...entries.values()].sort((left, right) => entryKey(left).localeCompare(entryKey(right))),
  );
  const entriesFingerprint = sha256(JSON.stringify(canonicalEntries));
  const obligationsFingerprint = restorePrivacyObligationsFingerprint(report.obligations);

  const manifest = Object.freeze({
    manifestVersion: RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION,
    backupCutoff: report.backupCutoff,
    reconciliationStatus: report.status,
    ledgerGeneratedAt: report.ledger?.generatedAt ?? null,
    ledgerEntriesFingerprint: report.ledger?.entriesFingerprint ?? null,
    journalMarkerCount: report.journalMarkerCount,
    obligationCount: report.obligations.length,
    obligationsFingerprint,
    entryCount: canonicalEntries.length,
    entriesFingerprint,
    entries: canonicalEntries,
  });
  verifyRestorePrivacyArtifactReplayManifest(manifest, report);
  return manifest;
}

export async function readVerifiedRestorePrivacyArtifactReplayManifestIfPresent(
  filePath: string,
  report: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<RestorePrivacyArtifactReplayManifest> | null> {
  let serialized: string;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: RestorePrivacyArtifactReplayManifest;
  try {
    parsed = JSON.parse(serialized) as RestorePrivacyArtifactReplayManifest;
  } catch (error) {
    throw new Error('Restore privacy artifact replay manifest is not valid JSON', { cause: error });
  }
  verifyRestorePrivacyArtifactReplayManifest(parsed, report);
  await chmod(filePath, 0o600);
  return Object.freeze(parsed);
}

export async function persistRestorePrivacyArtifactReplayManifest(
  filePath: string,
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
): Promise<Readonly<PersistedRestorePrivacyArtifactReplayManifest>> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    await writeFile(filePath, serialized, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ created: true, manifest });
  } catch (error) {
    const existing = await readFile(filePath, 'utf8').catch(() => null);
    if (existing === serialized) {
      await chmod(filePath, 0o600);
      return Object.freeze({ created: false, manifest });
    }
    if (existing !== null) {
      throw new Error('Restore privacy artifact replay manifest already exists with different content', { cause: error });
    }
    throw error;
  }
}
