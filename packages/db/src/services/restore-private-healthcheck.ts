import { asc, inArray } from 'drizzle-orm';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Database } from '../client';
import {
  athleteAnonymizationExecutions,
  athleteDataSubjectDeliveryPackages,
  reportVersions,
  restorePrivateRecoveryNormalizations,
  tenantExportPackages,
  type RestorePrivateRecoveryNormalizationRow,
} from '../schema';
import {
  verifyRestorePrivacyArtifactReplayResult,
  type RestorePrivacyArtifactReplayResult,
  type RestorePrivacyArtifactReplayRoots,
} from './restore-privacy-artifact-replay';
import {
  verifyRestorePrivacyArtifactReplayManifest,
  type RestorePrivacyArtifactReplayManifest,
} from './restore-privacy-artifact-replay-manifest';
import {
  assessRestorePrivacyReplayDatabase,
  type RestorePrivacyReplayDatabaseStatus,
} from './restore-privacy-replay-assessment';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVATE_HEALTHCHECK_VERSION = 1 as const;

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;

export type RestorePrivateHealthcheckStatus = 'HEALTHY' | 'BLOCKED';
export type RestorePrivateStorageKind = 'REPORT' | 'TENANT_EXPORT' | 'DATA_SUBJECT_DELIVERY';

export type RestorePrivateHealthcheckBlockerCode =
  | 'RECONCILIATION_BLOCKED'
  | 'DATABASE_REPLAY_NOT_SATISFIED'
  | 'ARTIFACT_REPLAY_MANIFEST_MISSING'
  | 'ARTIFACT_REPLAY_MANIFEST_INVALID'
  | 'ARTIFACT_REPLAY_RESULT_MISSING'
  | 'ARTIFACT_REPLAY_RESULT_INVALID'
  | 'STORAGE_ROOT_INVALID'
  | 'STORAGE_SCAN_FAILED'
  | 'STORAGE_SYMLINK_PRESENT'
  | 'STORAGE_SPECIAL_ENTRY_PRESENT'
  | 'ACTIVE_ARTIFACT_MISSING'
  | 'ACTIVE_ARTIFACT_ORPHANED'
  | 'ANONYMIZATION_EXECUTION_TRANSIENT'
  | 'RECOVERY_NORMALIZATION_INVALID'
  | 'ANONYMIZATION_QUARANTINE_NOT_EMPTY';

export interface RestorePrivateHealthcheckBlocker {
  readonly code: RestorePrivateHealthcheckBlockerCode;
  readonly kind: RestorePrivateStorageKind | null;
  readonly reference: string | null;
  readonly executionId: string | null;
  readonly executionStatus: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED' | null;
}

export interface RestorePrivateStorageHealth {
  readonly kind: RestorePrivateStorageKind;
  readonly databaseReferenceCount: number;
  readonly activeFileCount: number;
  readonly quarantineFileCount: number;
  readonly symlinkCount: number;
  readonly specialEntryCount: number;
}

export interface RestorePrivateTransientExecution {
  readonly executionId: string;
  readonly tenantId: string;
  readonly athleteId: string;
  readonly status: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED';
}

export interface RestorePrivateNormalizedTransientExecution {
  readonly executionId: string;
  readonly tenantId: string;
  readonly athleteId: string;
  readonly snapshotStatus: 'PREPARING' | 'ARTIFACTS_STAGED';
  readonly sourceDbCommittedAt: string;
  readonly recoveryStartedAt: string;
  readonly normalizedAt: string;
  readonly planFingerprint: string;
}

export interface RestorePrivateHealthcheckReport {
  readonly healthcheckVersion: typeof RESTORE_PRIVATE_HEALTHCHECK_VERSION;
  readonly backupCutoff: string;
  readonly status: RestorePrivateHealthcheckStatus;
  readonly healthcheckPassed: boolean;
  readonly readyForPromotionReview: boolean;
  readonly promotionAllowed: false;
  readonly reconciliationStatus: RestorePrivacyReconciliationReport['status'];
  readonly databaseStatus: RestorePrivacyReplayDatabaseStatus;
  readonly artifactManifestVerified: boolean;
  readonly artifactReplayVerified: boolean;
  readonly storage: readonly Readonly<RestorePrivateStorageHealth>[];
  readonly transientExecutions: readonly Readonly<RestorePrivateTransientExecution>[];
  readonly normalizedTransientExecutions: readonly Readonly<RestorePrivateNormalizedTransientExecution>[];
  readonly blockers: readonly Readonly<RestorePrivateHealthcheckBlocker>[];
}

interface StorageScan {
  readonly activeFiles: readonly string[];
  readonly quarantineFiles: readonly string[];
  readonly quarantineExecutionIds: readonly string[];
  readonly symlinks: readonly string[];
  readonly specialEntries: readonly string[];
  readonly rootValid: boolean;
  readonly scanFailed: boolean;
}

function blockerKey(blocker: Readonly<RestorePrivateHealthcheckBlocker>): string {
  return [
    blocker.code,
    blocker.kind ?? '',
    blocker.reference ?? '',
    blocker.executionId ?? '',
    blocker.executionStatus ?? '',
  ].join('\n');
}

function blocker(
  code: RestorePrivateHealthcheckBlockerCode,
  options: Readonly<{
    kind?: RestorePrivateStorageKind | null;
    reference?: string | null;
    executionId?: string | null;
    executionStatus?: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED' | null;
  }> = {},
): Readonly<RestorePrivateHealthcheckBlocker> {
  return Object.freeze({
    code,
    kind: options.kind ?? null,
    reference: options.reference ?? null,
    executionId: options.executionId ?? null,
    executionStatus: options.executionStatus ?? null,
  });
}

function isCanonicalTimestamp(value: string): boolean {
  return CANONICAL_UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function normalizationMatches(
  execution: Readonly<RestorePrivateTransientExecution>,
  normalization: Readonly<RestorePrivateRecoveryNormalizationRow>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): boolean {
  if (execution.status !== 'PREPARING' && execution.status !== 'ARTIFACTS_STAGED') return false;
  const obligation = reconciliation.obligations.find((item) => item.executionId === execution.executionId);
  if (!obligation) return false;
  return normalization.executionId === execution.executionId
    && normalization.tenantId === execution.tenantId
    && normalization.athleteId === execution.athleteId
    && normalization.backupCutoff === reconciliation.backupCutoff
    && normalization.snapshotStatus === execution.status
    && normalization.action === 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE'
    && normalization.effectBasis === 'POST_BACKUP_COMMITTED'
    && normalization.sourceDbCommittedAt === obligation.dbCommittedAt
    && obligation.tenantId === execution.tenantId
    && obligation.athleteId === execution.athleteId
    && SHA256_FINGERPRINT.test(normalization.planFingerprint)
    && SHA256_FINGERPRINT.test(normalization.actionsFingerprint)
    && HMAC_SHA256_SIGNATURE.test(normalization.intentSignature)
    && isCanonicalTimestamp(normalization.backupCutoff)
    && isCanonicalTimestamp(normalization.sourceDbCommittedAt)
    && isCanonicalTimestamp(normalization.recoveryStartedAt)
    && isCanonicalTimestamp(normalization.normalizedAt)
    && isCanonicalTimestamp(normalization.createdAt)
    && normalization.sourceDbCommittedAt > normalization.backupCutoff
    && normalization.recoveryStartedAt >= normalization.sourceDbCommittedAt
    && normalization.normalizedAt >= normalization.recoveryStartedAt
    && normalization.createdAt === normalization.normalizedAt;
}

function normalizedExecution(
  normalization: Readonly<RestorePrivateRecoveryNormalizationRow>,
): Readonly<RestorePrivateNormalizedTransientExecution> {
  return Object.freeze({
    executionId: normalization.executionId,
    tenantId: normalization.tenantId,
    athleteId: normalization.athleteId,
    snapshotStatus: normalization.snapshotStatus,
    sourceDbCommittedAt: normalization.sourceDbCommittedAt,
    recoveryStartedAt: normalization.recoveryStartedAt,
    normalizedAt: normalization.normalizedAt,
    planFingerprint: normalization.planFingerprint,
  });
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function quarantineExecutionId(reference: string): string | null {
  const prefix = '.anonymization-quarantine/';
  if (!reference.startsWith(prefix)) return null;
  const executionId = reference.slice(prefix.length).split('/')[0];
  return executionId?.trim() ? executionId : null;
}

async function scanStorageRoot(root: string): Promise<Readonly<StorageScan>> {
  if (!root.trim() || !isAbsolute(root)) {
    return Object.freeze({
      activeFiles: Object.freeze([]), quarantineFiles: Object.freeze([]),
      quarantineExecutionIds: Object.freeze([]), symlinks: Object.freeze([]),
      specialEntries: Object.freeze([]), rootValid: false, scanFailed: false,
    });
  }
  const resolvedRoot = resolve(root);
  try {
    const rootStat = await lstat(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return Object.freeze({
        activeFiles: Object.freeze([]), quarantineFiles: Object.freeze([]),
        quarantineExecutionIds: Object.freeze([]), symlinks: Object.freeze([]),
        specialEntries: Object.freeze([]), rootValid: false, scanFailed: false,
      });
    }
  } catch {
    return Object.freeze({
      activeFiles: Object.freeze([]), quarantineFiles: Object.freeze([]),
      quarantineExecutionIds: Object.freeze([]), symlinks: Object.freeze([]),
      specialEntries: Object.freeze([]), rootValid: false, scanFailed: false,
    });
  }

  const activeFiles: string[] = [];
  const quarantineFiles: string[] = [];
  const symlinks: string[] = [];
  const specialEntries: string[] = [];
  let scanFailed = false;

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      scanFailed = true;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const reference = portableRelative(resolvedRoot, fullPath);
      if (entry.isSymbolicLink()) {
        symlinks.push(reference);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        if (reference === '.anonymization-quarantine' || reference.startsWith('.anonymization-quarantine/')) {
          quarantineFiles.push(reference);
        } else {
          activeFiles.push(reference);
        }
        continue;
      }
      specialEntries.push(reference);
    }
  }

  await walk(resolvedRoot);
  const quarantineExecutionIds = [...new Set(
    quarantineFiles.map(quarantineExecutionId).filter((value): value is string => value !== null),
  )].sort();
  return Object.freeze({
    activeFiles: Object.freeze(activeFiles.sort()),
    quarantineFiles: Object.freeze(quarantineFiles.sort()),
    quarantineExecutionIds: Object.freeze(quarantineExecutionIds),
    symlinks: Object.freeze(symlinks.sort()),
    specialEntries: Object.freeze(specialEntries.sort()),
    rootValid: true,
    scanFailed,
  });
}

async function databaseReferences(db: Database): Promise<Readonly<Record<RestorePrivateStorageKind, readonly string[]>>> {
  const [reports, tenantExports, deliveries] = await Promise.all([
    db.select({ reference: reportVersions.storageReference }).from(reportVersions)
      .orderBy(asc(reportVersions.storageReference)),
    db.select({ reference: tenantExportPackages.storageReference }).from(tenantExportPackages)
      .orderBy(asc(tenantExportPackages.storageReference)),
    db.select({ reference: athleteDataSubjectDeliveryPackages.storageReference })
      .from(athleteDataSubjectDeliveryPackages)
      .orderBy(asc(athleteDataSubjectDeliveryPackages.storageReference)),
  ]);
  return Object.freeze({
    REPORT: Object.freeze([...new Set(reports.map((row) => row.reference))].sort()),
    TENANT_EXPORT: Object.freeze([...new Set(tenantExports.map((row) => row.reference))].sort()),
    DATA_SUBJECT_DELIVERY: Object.freeze([...new Set(deliveries.map((row) => row.reference))].sort()),
  });
}

function compareStorage(
  kind: RestorePrivateStorageKind,
  expectedReferences: readonly string[],
  scan: Readonly<StorageScan>,
  blockers: RestorePrivateHealthcheckBlocker[],
): Readonly<RestorePrivateStorageHealth> {
  if (!scan.rootValid) blockers.push(blocker('STORAGE_ROOT_INVALID', { kind }));
  if (scan.scanFailed) blockers.push(blocker('STORAGE_SCAN_FAILED', { kind }));
  for (const reference of scan.symlinks) blockers.push(blocker('STORAGE_SYMLINK_PRESENT', { kind, reference }));
  for (const reference of scan.specialEntries) {
    blockers.push(blocker('STORAGE_SPECIAL_ENTRY_PRESENT', { kind, reference }));
  }

  const expected = new Set(expectedReferences);
  const actual = new Set(scan.activeFiles);
  for (const reference of expectedReferences) {
    if (!actual.has(reference)) blockers.push(blocker('ACTIVE_ARTIFACT_MISSING', { kind, reference }));
  }
  for (const reference of scan.activeFiles) {
    if (!expected.has(reference)) blockers.push(blocker('ACTIVE_ARTIFACT_ORPHANED', { kind, reference }));
  }
  for (const reference of scan.quarantineFiles) {
    blockers.push(blocker('ANONYMIZATION_QUARANTINE_NOT_EMPTY', {
      kind,
      reference,
      executionId: quarantineExecutionId(reference),
    }));
  }

  return Object.freeze({
    kind,
    databaseReferenceCount: expectedReferences.length,
    activeFileCount: scan.activeFiles.length,
    quarantineFileCount: scan.quarantineFiles.length,
    symlinkCount: scan.symlinks.length,
    specialEntryCount: scan.specialEntries.length,
  });
}

/**
 * Read-only final-state healthcheck for the isolated restore workspace.
 *
 * This deliberately performs no recovery and grants no promotion. Historical PREPARING or
 * ARTIFACTS_STAGED executions remain blockers unless immutable restore-recovery normalization
 * evidence exactly binds them to the current post-backup reconciliation obligation.
 */
export async function assessRestorePrivateHealthcheck(
  db: Database,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  artifactManifest: Readonly<RestorePrivacyArtifactReplayManifest> | null,
  artifactResult: Readonly<RestorePrivacyArtifactReplayResult> | null,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
): Promise<Readonly<RestorePrivateHealthcheckReport>> {
  const blockers: RestorePrivateHealthcheckBlocker[] = [];
  if (reconciliation.status === 'BLOCKED' || !reconciliation.reconciliationReady) {
    blockers.push(blocker('RECONCILIATION_BLOCKED'));
  }

  const databaseAssessment = await assessRestorePrivacyReplayDatabase(db, reconciliation);
  if (databaseAssessment.status !== 'DATABASE_SATISFIED') {
    blockers.push(blocker('DATABASE_REPLAY_NOT_SATISFIED'));
  }

  let artifactManifestVerified = false;
  if (!artifactManifest) {
    blockers.push(blocker('ARTIFACT_REPLAY_MANIFEST_MISSING'));
  } else {
    try {
      verifyRestorePrivacyArtifactReplayManifest(artifactManifest, reconciliation);
      artifactManifestVerified = true;
    } catch {
      blockers.push(blocker('ARTIFACT_REPLAY_MANIFEST_INVALID'));
    }
  }

  let artifactReplayVerified = false;
  if (!artifactResult) {
    blockers.push(blocker('ARTIFACT_REPLAY_RESULT_MISSING'));
  } else if (!artifactManifest) {
    blockers.push(blocker('ARTIFACT_REPLAY_RESULT_INVALID'));
  } else {
    try {
      verifyRestorePrivacyArtifactReplayResult(artifactResult, artifactManifest);
      artifactReplayVerified = true;
    } catch {
      blockers.push(blocker('ARTIFACT_REPLAY_RESULT_INVALID'));
    }
  }

  const transientRows = await db.select({
    executionId: athleteAnonymizationExecutions.id,
    tenantId: athleteAnonymizationExecutions.tenantId,
    athleteId: athleteAnonymizationExecutions.athleteId,
    status: athleteAnonymizationExecutions.status,
  }).from(athleteAnonymizationExecutions).where(inArray(
    athleteAnonymizationExecutions.status,
    ['PREPARING', 'ARTIFACTS_STAGED', 'DB_COMMITTED'],
  )).orderBy(asc(athleteAnonymizationExecutions.id));

  const normalizationRows = transientRows.length === 0
    ? []
    : await db.select().from(restorePrivateRecoveryNormalizations).where(inArray(
      restorePrivateRecoveryNormalizations.executionId,
      transientRows.map((row) => row.executionId),
    )).orderBy(asc(restorePrivateRecoveryNormalizations.executionId));
  const normalizationByExecutionId = new Map(
    normalizationRows.map((row) => [row.executionId, row] as const),
  );

  const unresolvedTransients: Readonly<RestorePrivateTransientExecution>[] = [];
  const normalizedTransients: Readonly<RestorePrivateNormalizedTransientExecution>[] = [];
  for (const row of transientRows) {
    const execution = Object.freeze({
      executionId: row.executionId,
      tenantId: row.tenantId,
      athleteId: row.athleteId,
      status: row.status as RestorePrivateTransientExecution['status'],
    });
    const normalization = normalizationByExecutionId.get(execution.executionId);
    if (normalization && normalizationMatches(execution, normalization, reconciliation)) {
      normalizedTransients.push(normalizedExecution(normalization));
      continue;
    }
    unresolvedTransients.push(execution);
    if (normalization) {
      blockers.push(blocker('RECOVERY_NORMALIZATION_INVALID', {
        executionId: execution.executionId,
        executionStatus: execution.status,
      }));
    }
    blockers.push(blocker('ANONYMIZATION_EXECUTION_TRANSIENT', {
      executionId: execution.executionId,
      executionStatus: execution.status,
    }));
  }
  const transientExecutions = Object.freeze(unresolvedTransients);
  const normalizedTransientExecutions = Object.freeze(normalizedTransients);

  const references = await databaseReferences(db);
  const [reportScan, tenantExportScan, deliveryScan] = await Promise.all([
    scanStorageRoot(roots.reportRoot),
    scanStorageRoot(roots.tenantExportRoot),
    scanStorageRoot(roots.dataSubjectDeliveryRoot),
  ]);
  const storage = Object.freeze([
    compareStorage('REPORT', references.REPORT, reportScan, blockers),
    compareStorage('TENANT_EXPORT', references.TENANT_EXPORT, tenantExportScan, blockers),
    compareStorage('DATA_SUBJECT_DELIVERY', references.DATA_SUBJECT_DELIVERY, deliveryScan, blockers),
  ]);

  const canonicalBlockers = Object.freeze(
    [...new Map(blockers.map((item) => [blockerKey(item), item] as const)).values()]
      .sort((left, right) => blockerKey(left).localeCompare(blockerKey(right))),
  );
  const healthcheckPassed = canonicalBlockers.length === 0;
  return Object.freeze({
    healthcheckVersion: RESTORE_PRIVATE_HEALTHCHECK_VERSION,
    backupCutoff: reconciliation.backupCutoff,
    status: healthcheckPassed ? 'HEALTHY' : 'BLOCKED',
    healthcheckPassed,
    readyForPromotionReview: healthcheckPassed,
    promotionAllowed: false,
    reconciliationStatus: reconciliation.status,
    databaseStatus: databaseAssessment.status,
    artifactManifestVerified,
    artifactReplayVerified,
    storage,
    transientExecutions,
    normalizedTransientExecutions,
    blockers: canonicalBlockers,
  });
}
