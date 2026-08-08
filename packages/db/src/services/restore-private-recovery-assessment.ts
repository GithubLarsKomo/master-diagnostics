import { asc, inArray } from 'drizzle-orm';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Database } from '../client';
import {
  athleteAnonymizationExecutionArtifacts,
  athleteAnonymizationExecutions,
} from '../schema';
import type {
  AthleteAnonymizationExecutionArtifactKind,
  AthleteAnonymizationExecutionStatus,
} from './anonymization-execution';
import type { RestorePrivacyArtifactReplayRoots } from './restore-privacy-artifact-replay';
import type {
  RestorePrivateHealthcheckBlocker,
  RestorePrivateHealthcheckReport,
  RestorePrivateStorageKind,
} from './restore-private-healthcheck';
import type {
  RestorePrivacyReconciliationReport,
  RestorePrivacyReplayObligation,
} from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION = 1 as const;

export type RestorePrivateRecoveryAssessmentStatus =
  | 'NOT_REQUIRED'
  | 'RECOVERY_READY'
  | 'BLOCKED';

export type RestorePrivateRecoveryActionType =
  | 'ABORT_PREPARING'
  | 'RESTORE_ARTIFACTS_AND_ABORT'
  | 'PURGE_ARTIFACTS_AND_COMPLETE'
  | 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE';

export type RestorePrivateRecoveryEffectBasis =
  | 'NO_COMMITTED_EFFECT_AFTER_CUTOFF'
  | 'PRE_CUTOFF_DB_COMMITTED'
  | 'POST_BACKUP_COMMITTED';

export type RestorePrivateRecoveryBlockerCode =
  | 'HEALTHCHECK_EVIDENCE_NOT_READY'
  | 'HEALTHCHECK_BLOCKER_NOT_RECOVERABLE'
  | 'RECOVERY_TARGET_MISSING'
  | 'EXECUTION_NOT_FOUND'
  | 'EXECUTION_HEALTHCHECK_STATE_CHANGED'
  | 'EXECUTION_OBLIGATION_STATE_CONFLICT'
  | 'EXECUTION_COMMIT_TIMESTAMP_INVALID'
  | 'ARTIFACT_REFERENCE_INVALID'
  | 'ARTIFACT_STATE_CONFLICT'
  | 'ARTIFACT_OWNERSHIP_CONFLICT'
  | 'QUARANTINE_NOT_IN_EXECUTION_MANIFEST';

export interface RestorePrivateRecoveryAction {
  readonly executionId: string;
  readonly tenantId: string;
  readonly athleteId: string;
  readonly snapshotStatus: AthleteAnonymizationExecutionStatus;
  readonly action: RestorePrivateRecoveryActionType;
  readonly effectBasis: RestorePrivateRecoveryEffectBasis;
  readonly committedAt: string | null;
  readonly artifactCount: number;
  readonly activeArtifactCount: number;
  readonly quarantinedArtifactCount: number;
  readonly absentArtifactCount: number;
}

export interface RestorePrivateRecoveryBlocker {
  readonly code: RestorePrivateRecoveryBlockerCode;
  readonly executionId: string | null;
  readonly healthcheckCode: RestorePrivateHealthcheckBlocker['code'] | null;
  readonly kind: RestorePrivateStorageKind | null;
  readonly reference: string | null;
}

export interface RestorePrivateRecoveryAssessment {
  readonly assessmentVersion: typeof RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION;
  readonly backupCutoff: string;
  readonly status: RestorePrivateRecoveryAssessmentStatus;
  readonly recoveryRequired: boolean;
  readonly recoveryReady: boolean;
  readonly promotionAllowed: false;
  readonly actions: readonly Readonly<RestorePrivateRecoveryAction>[];
  readonly blockers: readonly Readonly<RestorePrivateRecoveryBlocker>[];
}

type ArtifactPresence = 'ACTIVE' | 'QUARANTINED' | 'ABSENT';

interface ExecutionArtifactState {
  readonly kind: AthleteAnonymizationExecutionArtifactKind;
  readonly storageReference: string;
  readonly presence: ArtifactPresence;
}

const RECOVERABLE_HEALTHCHECK_CODES = new Set<RestorePrivateHealthcheckBlocker['code']>([
  'ACTIVE_ARTIFACT_MISSING',
  'ANONYMIZATION_EXECUTION_TRANSIENT',
  'ANONYMIZATION_QUARANTINE_NOT_EMPTY',
]);
const REPORT_REFERENCE = /^[a-zA-Z0-9/_-]+\.pdf$/;
const TENANT_EXPORT_REFERENCE = /^[a-f0-9-]+\.mde$/;
const DATA_SUBJECT_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;
const EXECUTION_ID = /^[a-zA-Z0-9-]{8,80}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function blockerKey(item: Readonly<RestorePrivateRecoveryBlocker>): string {
  return [
    item.code,
    item.executionId ?? '',
    item.healthcheckCode ?? '',
    item.kind ?? '',
    item.reference ?? '',
  ].join('\n');
}

function actionKey(item: Readonly<RestorePrivateRecoveryAction>): string {
  return item.executionId;
}

function blocker(
  code: RestorePrivateRecoveryBlockerCode,
  options: Readonly<{
    executionId?: string | null;
    healthcheckCode?: RestorePrivateHealthcheckBlocker['code'] | null;
    kind?: RestorePrivateStorageKind | null;
    reference?: string | null;
  }> = {},
): Readonly<RestorePrivateRecoveryBlocker> {
  return Object.freeze({
    code,
    executionId: options.executionId ?? null,
    healthcheckCode: options.healthcheckCode ?? null,
    kind: options.kind ?? null,
    reference: options.reference ?? null,
  });
}

function canonicalBlockers(
  blockers: readonly Readonly<RestorePrivateRecoveryBlocker>[],
): readonly Readonly<RestorePrivateRecoveryBlocker>[] {
  return Object.freeze(
    [...new Map(blockers.map((item) => [blockerKey(item), item] as const)).values()]
      .sort((left, right) => blockerKey(left).localeCompare(blockerKey(right))),
  );
}

function result(
  backupCutoff: string,
  actions: readonly Readonly<RestorePrivateRecoveryAction>[],
  blockers: readonly Readonly<RestorePrivateRecoveryBlocker>[],
): Readonly<RestorePrivateRecoveryAssessment> {
  const sortedActions = Object.freeze([...actions].sort((left, right) => actionKey(left).localeCompare(actionKey(right))));
  const sortedBlockers = canonicalBlockers(blockers);
  const status: RestorePrivateRecoveryAssessmentStatus = sortedBlockers.length > 0
    ? 'BLOCKED'
    : sortedActions.length > 0
      ? 'RECOVERY_READY'
      : 'NOT_REQUIRED';
  return Object.freeze({
    assessmentVersion: RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION,
    backupCutoff,
    status,
    recoveryRequired: sortedActions.length > 0 || sortedBlockers.length > 0,
    recoveryReady: status === 'RECOVERY_READY',
    promotionAllowed: false,
    actions: sortedActions,
    blockers: sortedBlockers,
  });
}

function healthKind(kind: AthleteAnonymizationExecutionArtifactKind): RestorePrivateStorageKind {
  if (kind === 'REPORT') return 'REPORT';
  if (kind === 'TENANT_EXPORT') return 'TENANT_EXPORT';
  return 'DATA_SUBJECT_DELIVERY';
}

function rootForArtifact(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  kind: AthleteAnonymizationExecutionArtifactKind,
): string {
  if (kind === 'REPORT') return roots.reportRoot;
  if (kind === 'TENANT_EXPORT') return roots.tenantExportRoot;
  return roots.dataSubjectDeliveryRoot;
}

function safeReference(kind: AthleteAnonymizationExecutionArtifactKind, reference: string): boolean {
  if (!reference || reference.startsWith('/') || reference.includes('..') || reference.includes('\\')) return false;
  if (kind === 'REPORT') return REPORT_REFERENCE.test(reference);
  if (kind === 'TENANT_EXPORT') return TENANT_EXPORT_REFERENCE.test(reference);
  return DATA_SUBJECT_REFERENCE.test(reference);
}

function nestedPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === '' || (
    candidate !== '..'
    && !candidate.startsWith(`..${sep}`)
    && !isAbsolute(candidate)
  );
}

function resolvedTarget(root: string, reference: string): string | null {
  if (!root.trim() || !isAbsolute(root)) return null;
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, reference);
  return nestedPath(resolvedRoot, target) && target !== resolvedRoot ? target : null;
}

async function filePresence(path: string): Promise<'FILE' | 'ABSENT' | 'INVALID'> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() ? 'FILE' : 'INVALID';
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'ABSENT';
    return 'INVALID';
  }
}

async function inspectArtifact(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  executionId: string,
  kind: AthleteAnonymizationExecutionArtifactKind,
  reference: string,
): Promise<Readonly<ExecutionArtifactState> | null> {
  if (!EXECUTION_ID.test(executionId) || !safeReference(kind, reference)) return null;
  const root = rootForArtifact(roots, kind);
  const active = resolvedTarget(root, reference);
  const quarantined = resolvedTarget(root, join('.anonymization-quarantine', executionId, reference));
  if (!active || !quarantined) return null;
  const [activeState, quarantineState] = await Promise.all([
    filePresence(active),
    filePresence(quarantined),
  ]);
  if (activeState === 'INVALID' || quarantineState === 'INVALID') return null;
  if (activeState === 'FILE' && quarantineState === 'FILE') return null;
  return Object.freeze({
    kind,
    storageReference: reference,
    presence: activeState === 'FILE'
      ? 'ACTIVE'
      : quarantineState === 'FILE'
        ? 'QUARANTINED'
        : 'ABSENT',
  });
}

function expectedQuarantineReference(
  executionId: string,
  reference: string,
): string {
  return ['.anonymization-quarantine', executionId, reference].join('/');
}

function stateCounts(states: readonly Readonly<ExecutionArtifactState>[]) {
  return Object.freeze({
    artifactCount: states.length,
    activeArtifactCount: states.filter((item) => item.presence === 'ACTIVE').length,
    quarantinedArtifactCount: states.filter((item) => item.presence === 'QUARANTINED').length,
    absentArtifactCount: states.filter((item) => item.presence === 'ABSENT').length,
  });
}

function canonicalTimestamp(value: string | null): value is string {
  return value !== null && CANONICAL_UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function action(
  execution: typeof athleteAnonymizationExecutions.$inferSelect,
  actionType: RestorePrivateRecoveryActionType,
  effectBasis: RestorePrivateRecoveryEffectBasis,
  committedAt: string | null,
  states: readonly Readonly<ExecutionArtifactState>[],
): Readonly<RestorePrivateRecoveryAction> {
  return Object.freeze({
    executionId: execution.id,
    tenantId: execution.tenantId,
    athleteId: execution.athleteId,
    snapshotStatus: execution.status,
    action: actionType,
    effectBasis,
    committedAt,
    ...stateCounts(states),
  });
}

function matchingObligation(
  obligations: readonly Readonly<RestorePrivacyReplayObligation>[],
  executionId: string,
): Readonly<RestorePrivacyReplayObligation> | null {
  return obligations.find((item) => item.executionId === executionId) ?? null;
}

function healthcheckStateFor(
  healthcheck: Readonly<RestorePrivateHealthcheckReport>,
  executionId: string,
) {
  return healthcheck.transientExecutions.find((item) => item.executionId === executionId) ?? null;
}

/**
 * Classifies only the recovery that would be safe for historical anonymization state found in a
 * private restore snapshot. No DB row, artifact, journal marker or promotion state is modified.
 *
 * A signed post-backup COMMITTED obligation is authoritative over the older snapshot state. In
 * particular, PREPARING/ARTIFACTS_STAGED at the backup cutoff must never be rolled back when the
 * same execution later committed productively and was reconciled/replayed into the restore DB.
 */
export async function assessRestorePrivateRecovery(
  db: Database,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  healthcheck: Readonly<RestorePrivateHealthcheckReport>,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
): Promise<Readonly<RestorePrivateRecoveryAssessment>> {
  const blockers: RestorePrivateRecoveryBlocker[] = [];

  if (
    reconciliation.status === 'BLOCKED'
    || !reconciliation.reconciliationReady
    || healthcheck.backupCutoff !== reconciliation.backupCutoff
    || healthcheck.reconciliationStatus !== reconciliation.status
    || healthcheck.databaseStatus !== 'DATABASE_SATISFIED'
    || !healthcheck.artifactManifestVerified
    || !healthcheck.artifactReplayVerified
  ) {
    blockers.push(blocker('HEALTHCHECK_EVIDENCE_NOT_READY'));
  }
  for (const item of healthcheck.blockers) {
    if (!RECOVERABLE_HEALTHCHECK_CODES.has(item.code)) {
      blockers.push(blocker('HEALTHCHECK_BLOCKER_NOT_RECOVERABLE', {
        executionId: item.executionId,
        healthcheckCode: item.code,
        kind: item.kind,
        reference: item.reference,
      }));
    }
  }
  if (blockers.length > 0) return result(reconciliation.backupCutoff, [], blockers);
  if (healthcheck.healthcheckPassed && healthcheck.blockers.length === 0) {
    return result(reconciliation.backupCutoff, [], []);
  }

  const targetIds = [...new Set([
    ...healthcheck.transientExecutions.map((item) => item.executionId),
    ...healthcheck.blockers
      .filter((item) => item.code === 'ANONYMIZATION_QUARANTINE_NOT_EMPTY')
      .map((item) => item.executionId)
      .filter((value): value is string => value !== null),
  ])].sort();
  if (targetIds.length === 0) {
    blockers.push(blocker('RECOVERY_TARGET_MISSING'));
    return result(reconciliation.backupCutoff, [], blockers);
  }

  const [executionRows, artifactRows] = await Promise.all([
    db.select().from(athleteAnonymizationExecutions).where(
      inArray(athleteAnonymizationExecutions.id, targetIds),
    ).orderBy(asc(athleteAnonymizationExecutions.id)),
    db.select().from(athleteAnonymizationExecutionArtifacts).where(
      inArray(athleteAnonymizationExecutionArtifacts.executionId, targetIds),
    ).orderBy(
      asc(athleteAnonymizationExecutionArtifacts.executionId),
      asc(athleteAnonymizationExecutionArtifacts.kind),
      asc(athleteAnonymizationExecutionArtifacts.storageReference),
    ),
  ]);
  const executions = new Map(executionRows.map((row) => [row.id, row] as const));
  const artifactsByExecution = new Map<string, typeof artifactRows>();
  for (const row of artifactRows) {
    const current = artifactsByExecution.get(row.executionId) ?? [];
    current.push(row);
    artifactsByExecution.set(row.executionId, current);
  }
  for (const executionId of targetIds) {
    if (!executions.has(executionId)) blockers.push(blocker('EXECUTION_NOT_FOUND', { executionId }));
  }
  if (blockers.length > 0) return result(reconciliation.backupCutoff, [], blockers);

  const ownership = new Map<string, Set<string>>();
  for (const row of artifactRows) {
    const key = [healthKind(row.kind), row.storageReference].join('\n');
    const owners = ownership.get(key) ?? new Set<string>();
    owners.add(row.executionId);
    ownership.set(key, owners);
  }
  for (const item of healthcheck.blockers) {
    if (item.code !== 'ACTIVE_ARTIFACT_MISSING' || !item.kind || !item.reference) continue;
    const owners = ownership.get([item.kind, item.reference].join('\n')) ?? new Set<string>();
    if (owners.size === 0) {
      blockers.push(blocker('HEALTHCHECK_BLOCKER_NOT_RECOVERABLE', {
        healthcheckCode: item.code,
        kind: item.kind,
        reference: item.reference,
      }));
    } else if (owners.size > 1) {
      blockers.push(blocker('ARTIFACT_OWNERSHIP_CONFLICT', {
        healthcheckCode: item.code,
        kind: item.kind,
        reference: item.reference,
      }));
    }
  }

  for (const item of healthcheck.blockers) {
    if (item.code !== 'ANONYMIZATION_QUARANTINE_NOT_EMPTY') continue;
    if (!item.executionId || !item.kind || !item.reference) {
      blockers.push(blocker('QUARANTINE_NOT_IN_EXECUTION_MANIFEST', {
        executionId: item.executionId,
        kind: item.kind,
        reference: item.reference,
      }));
      continue;
    }
    const artifacts = artifactsByExecution.get(item.executionId) ?? [];
    const matches = artifacts.some((row) => healthKind(row.kind) === item.kind
      && expectedQuarantineReference(item.executionId, row.storageReference) === item.reference);
    if (!matches) {
      blockers.push(blocker('QUARANTINE_NOT_IN_EXECUTION_MANIFEST', {
        executionId: item.executionId,
        kind: item.kind,
        reference: item.reference,
      }));
    }
  }
  if (blockers.length > 0) return result(reconciliation.backupCutoff, [], blockers);

  const actions: RestorePrivateRecoveryAction[] = [];
  for (const executionId of targetIds) {
    const execution = executions.get(executionId);
    if (!execution) continue;
    const healthState = healthcheckStateFor(healthcheck, executionId);
    if (healthState && (
      healthState.tenantId !== execution.tenantId
      || healthState.athleteId !== execution.athleteId
      || healthState.status !== execution.status
    )) {
      blockers.push(blocker('EXECUTION_HEALTHCHECK_STATE_CHANGED', { executionId }));
      continue;
    }

    const obligation = matchingObligation(reconciliation.obligations, executionId);
    if (obligation && (
      obligation.tenantId !== execution.tenantId
      || obligation.athleteId !== execution.athleteId
      || obligation.approvalId !== execution.approvalId
      || obligation.executionVersion !== execution.executionVersion
    )) {
      blockers.push(blocker('EXECUTION_OBLIGATION_STATE_CONFLICT', { executionId }));
      continue;
    }

    const artifactRowsForExecution = artifactsByExecution.get(executionId) ?? [];
    const states: ExecutionArtifactState[] = [];
    let artifactInvalid = false;
    for (const artifact of artifactRowsForExecution) {
      const state = await inspectArtifact(
        roots,
        executionId,
        artifact.kind,
        artifact.storageReference,
      );
      if (!state) {
        blockers.push(blocker(
          safeReference(artifact.kind, artifact.storageReference)
            ? 'ARTIFACT_STATE_CONFLICT'
            : 'ARTIFACT_REFERENCE_INVALID',
          {
            executionId,
            kind: healthKind(artifact.kind),
            reference: artifact.storageReference,
          },
        ));
        artifactInvalid = true;
        continue;
      }
      states.push(state);
    }
    if (artifactInvalid) continue;

    const counts = stateCounts(states);
    if (obligation) {
      if (execution.status !== 'PREPARING' && execution.status !== 'ARTIFACTS_STAGED') {
        blockers.push(blocker('EXECUTION_OBLIGATION_STATE_CONFLICT', { executionId }));
        continue;
      }
      if (counts.activeArtifactCount > 0) {
        blockers.push(blocker('ARTIFACT_STATE_CONFLICT', { executionId }));
        continue;
      }
      actions.push(action(
        execution,
        'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE',
        'POST_BACKUP_COMMITTED',
        obligation.dbCommittedAt,
        states,
      ));
      continue;
    }

    if (execution.status === 'PREPARING') {
      if (counts.absentArtifactCount > 0) {
        blockers.push(blocker('ARTIFACT_STATE_CONFLICT', { executionId }));
        continue;
      }
      actions.push(action(
        execution,
        counts.quarantinedArtifactCount > 0 ? 'RESTORE_ARTIFACTS_AND_ABORT' : 'ABORT_PREPARING',
        'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
        null,
        states,
      ));
      continue;
    }

    if (execution.status === 'ARTIFACTS_STAGED') {
      if (counts.activeArtifactCount > 0 || counts.absentArtifactCount > 0) {
        blockers.push(blocker('ARTIFACT_STATE_CONFLICT', { executionId }));
        continue;
      }
      actions.push(action(
        execution,
        'RESTORE_ARTIFACTS_AND_ABORT',
        'NO_COMMITTED_EFFECT_AFTER_CUTOFF',
        null,
        states,
      ));
      continue;
    }

    if (execution.status === 'DB_COMMITTED') {
      if (!canonicalTimestamp(execution.dbCommittedAt) || execution.dbCommittedAt > reconciliation.backupCutoff) {
        blockers.push(blocker('EXECUTION_COMMIT_TIMESTAMP_INVALID', { executionId }));
        continue;
      }
      if (counts.activeArtifactCount > 0) {
        blockers.push(blocker('ARTIFACT_STATE_CONFLICT', { executionId }));
        continue;
      }
      actions.push(action(
        execution,
        'PURGE_ARTIFACTS_AND_COMPLETE',
        'PRE_CUTOFF_DB_COMMITTED',
        execution.dbCommittedAt,
        states,
      ));
      continue;
    }

    blockers.push(blocker('EXECUTION_OBLIGATION_STATE_CONFLICT', { executionId }));
  }

  if (blockers.length > 0) return result(reconciliation.backupCutoff, [], blockers);
  return result(reconciliation.backupCutoff, actions, []);
}
