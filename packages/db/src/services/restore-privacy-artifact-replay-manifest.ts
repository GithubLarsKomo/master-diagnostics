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

function assertSafeReportReference(reference: string, tenantId: string, testId: string): void {
  if (
    !REPORT_REFERENCE.test(reference)
    || reference.startsWith('/')
    || reference.includes('..')
    || !reference.startsWith(`${tenantId}/${testId}/`)
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
  const canonicalObligationList = canonicalObligations(report.obligations);
  const entriesFingerprint = sha256(JSON.stringify(canonicalEntries));
  const obligationsFingerprint = sha256(JSON.stringify(canonicalObligationList));

  return Object.freeze({
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
