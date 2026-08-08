import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteAnonymizationExecutions } from '../schema';
import { appendAuditEvent } from './audit';
import type { RestorePrivacyArtifactReplayRoots } from './restore-privacy-artifact-replay';
import {
  readVerifiedRestorePrivateRecoveryIntent,
  type SignedRestorePrivateRecoveryIntentEnvelope,
} from './restore-private-recovery-intent';
import {
  getRestorePrivateRecoveryNormalization,
  recordRestorePrivateRecoveryNormalization,
} from './restore-private-recovery-normalization';
import {
  verifyRestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlanAction,
  type RestorePrivateRecoveryPlanArtifact,
} from './restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export type RestorePrivateRecoveryExecutionActionStatus = 'APPLIED' | 'ALREADY_APPLIED';

export interface RestorePrivateRecoveryExecutionActionResult {
  readonly executionId: string;
  readonly action: RestorePrivateRecoveryPlanAction['action'];
  readonly status: RestorePrivateRecoveryExecutionActionStatus;
  readonly artifactMutationCount: number;
  readonly terminalEvidence:
    | 'ABORTED_EXECUTION'
    | 'COMPLETED_EXECUTION'
    | 'RESTORE_NORMALIZATION';
}

export interface RestorePrivateRecoveryExecutionResult {
  readonly mode: 'ISOLATED_RESTORE_RECOVERY_EXECUTION';
  readonly backupCutoff: string;
  readonly planFingerprint: `sha256:${string}`;
  readonly recoveryStartedAt: string;
  readonly actionCount: number;
  readonly appliedCount: number;
  readonly alreadyAppliedCount: number;
  readonly actions: readonly Readonly<RestorePrivateRecoveryExecutionActionResult>[];
  readonly promotionAllowed: false;
}

export interface ExecuteRestorePrivateRecoveryInput {
  readonly plan: Readonly<RestorePrivateRecoveryPlan>;
  readonly reconciliation: Readonly<RestorePrivacyReconciliationReport>;
  readonly intentFile: string;
  readonly intentKeyFile: string;
  readonly roots: Readonly<RestorePrivacyArtifactReplayRoots>;
  readonly normalizedAt?: string;
}

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function nestedPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === '' || (
    candidate !== '..'
    && !candidate.startsWith(`..${sep}`)
    && !isAbsolute(candidate)
  );
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function verifiedRoot(path: string, label: string): Promise<string> {
  if (!path.trim() || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const root = resolve(path);
  const stat = await lstatIfPresent(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return root;
}

async function verifiedRoots(roots: Readonly<RestorePrivacyArtifactReplayRoots>) {
  const reportRoot = await verifiedRoot(roots.reportRoot, 'Restore recovery executor report root');
  const tenantExportRoot = await verifiedRoot(
    roots.tenantExportRoot,
    'Restore recovery executor tenant export root',
  );
  const dataSubjectDeliveryRoot = await verifiedRoot(
    roots.dataSubjectDeliveryRoot,
    'Restore recovery executor data subject delivery root',
  );
  const pairs: readonly (readonly [string, string])[] = [
    [reportRoot, tenantExportRoot],
    [reportRoot, dataSubjectDeliveryRoot],
    [tenantExportRoot, dataSubjectDeliveryRoot],
  ];
  for (const [left, right] of pairs) {
    if (nestedPath(left, right) || nestedPath(right, left)) {
      throw new Error('Restore recovery executor roots must be distinct non-overlapping directories');
    }
  }
  return Object.freeze({ reportRoot, tenantExportRoot, dataSubjectDeliveryRoot });
}

function rootForKind(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  kind: RestorePrivateRecoveryPlanArtifact['kind'],
): string {
  if (kind === 'REPORT') return roots.reportRoot;
  if (kind === 'TENANT_EXPORT') return roots.tenantExportRoot;
  return roots.dataSubjectDeliveryRoot;
}

async function checkedTarget(root: string, reference: string): Promise<Readonly<{ path: string; exists: boolean }>> {
  const target = resolve(root, reference);
  if (!nestedPath(root, target) || target === root) {
    throw new Error('Restore recovery executor artifact path escapes its private storage root');
  }
  let current = root;
  const parts = reference.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstatIfPresent(current);
    if (!stat) return Object.freeze({ path: target, exists: false });
    if (stat.isSymbolicLink()) {
      throw new Error('Restore recovery executor refuses symlink-backed artifact paths');
    }
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) {
      throw new Error('Restore recovery executor artifact parent path is not a directory');
    }
    if (last && !stat.isFile()) {
      throw new Error('Restore recovery executor artifact target is not a regular file');
    }
  }
  return Object.freeze({ path: target, exists: true });
}

async function artifactState(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  artifact: Readonly<RestorePrivateRecoveryPlanArtifact>,
) {
  const root = rootForKind(roots, artifact.kind);
  const active = await checkedTarget(root, artifact.storageReference);
  const quarantineReference = join(
    '.anonymization-quarantine',
    action.executionId,
    artifact.storageReference,
  );
  const quarantine = await checkedTarget(root, quarantineReference);
  if (active.exists && quarantine.exists) {
    throw new Error('Restore recovery executor found both active and quarantined artifact copies');
  }
  return Object.freeze({ root, active, quarantine });
}

async function restoreActionArtifacts(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
): Promise<number> {
  let mutations = 0;
  for (const artifact of action.artifacts) {
    const state = await artifactState(roots, action, artifact);
    if (artifact.expectedPresence === 'ABSENT') {
      throw new Error('Restore-and-abort recovery cannot accept an originally absent artifact');
    }
    if (artifact.expectedPresence === 'ACTIVE') {
      if (!state.active.exists || state.quarantine.exists) {
        throw new Error('Restore recovery executor expected the planned active artifact to remain active');
      }
      continue;
    }
    if (state.active.exists && !state.quarantine.exists) continue;
    if (!state.active.exists && state.quarantine.exists) {
      await mkdir(dirname(state.active.path), { recursive: true });
      const rechecked = await checkedTarget(state.root, artifact.storageReference);
      if (rechecked.exists) {
        throw new Error('Restore recovery executor active artifact appeared during restore');
      }
      await rename(state.quarantine.path, state.active.path);
      mutations += 1;
      continue;
    }
    throw new Error('Restore recovery executor cannot prove quarantined artifact restore progress');
  }
  return mutations;
}

async function assertActiveArtifactsUnchanged(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
): Promise<void> {
  for (const artifact of action.artifacts) {
    if (artifact.expectedPresence !== 'ACTIVE') {
      throw new Error('Abort-only recovery requires all planned artifacts to remain active');
    }
    const state = await artifactState(roots, action, artifact);
    if (!state.active.exists || state.quarantine.exists) {
      throw new Error('Abort-only recovery cannot prove the active artifact state');
    }
  }
}

async function purgeActionArtifacts(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
): Promise<number> {
  let mutations = 0;
  for (const artifact of action.artifacts) {
    if (artifact.expectedPresence === 'ACTIVE') {
      throw new Error('Forward-only recovery cannot purge an artifact planned as active');
    }
    const state = await artifactState(roots, action, artifact);
    if (state.active.exists) {
      throw new Error('Forward-only restore recovery refuses an active artifact copy');
    }
    if (artifact.expectedPresence === 'ABSENT') {
      if (state.quarantine.exists) {
        throw new Error('Restore recovery executor found quarantine content for an originally absent artifact');
      }
      continue;
    }
    if (state.quarantine.exists) {
      await rm(state.quarantine.path);
      mutations += 1;
    }
  }
  return mutations;
}

async function loadExecution(
  db: Database,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
) {
  const rows = await db.select().from(athleteAnonymizationExecutions).where(and(
    eq(athleteAnonymizationExecutions.id, action.executionId),
    eq(athleteAnonymizationExecutions.tenantId, action.tenantId),
    eq(athleteAnonymizationExecutions.athleteId, action.athleteId),
  )).limit(1);
  const row = rows[0];
  if (!row) throw new Error('Restore recovery executor cannot find the planned anonymization execution');
  return row;
}

async function abortExecution(
  db: Database,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
): Promise<RestorePrivateRecoveryExecutionActionStatus> {
  const current = await loadExecution(db, action);
  if (current.status === 'ABORTED') {
    if (current.abortedAt !== intent.record.startedAt) {
      throw new Error('Restore recovery executor found an ABORTED execution with a different recovery timestamp');
    }
    return 'ALREADY_APPLIED';
  }
  if (current.status !== action.snapshotStatus
    || (current.status !== 'PREPARING' && current.status !== 'ARTIFACTS_STAGED')) {
    throw new Error('Restore recovery executor found an unexpected execution state before abort');
  }
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(athleteAnonymizationExecutions).set({
      status: 'ABORTED',
      abortedAt: intent.record.startedAt,
      updatedAt: intent.record.startedAt,
    }).where(and(
      eq(athleteAnonymizationExecutions.id, action.executionId),
      eq(athleteAnonymizationExecutions.tenantId, action.tenantId),
      eq(athleteAnonymizationExecutions.athleteId, action.athleteId),
      eq(athleteAnonymizationExecutions.status, current.status),
    )).returning();
    if (!updated) throw new Error('Restore recovery executor lost the abortable execution state');
    await appendAuditEvent(tx, {
      tenantId: action.tenantId,
      actorRole: 'RESTORE_RECOVERY',
      action: 'restore.anonymization_execution_aborted',
      entityType: 'athlete_anonymization_execution',
      entityId: action.executionId,
      source: 'RESTORE_RECOVERY',
      before: { athleteId: action.athleteId, status: current.status },
      after: { athleteId: action.athleteId, status: 'ABORTED' },
      correlationId: intent.record.planFingerprint,
      occurredAt: intent.record.startedAt,
      recordedAt: intent.record.startedAt,
    });
  });
  return 'APPLIED';
}

async function completeExecution(
  db: Database,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
): Promise<RestorePrivateRecoveryExecutionActionStatus> {
  const current = await loadExecution(db, action);
  if (current.status === 'COMPLETED') {
    if (current.completedAt !== intent.record.startedAt) {
      throw new Error('Restore recovery executor found a COMPLETED execution with a different recovery timestamp');
    }
    return 'ALREADY_APPLIED';
  }
  if (current.status !== 'DB_COMMITTED' || action.snapshotStatus !== 'DB_COMMITTED') {
    throw new Error('Restore recovery executor requires the planned DB_COMMITTED execution before completion');
  }
  if (!current.dbCommittedAt || intent.record.startedAt < current.dbCommittedAt) {
    throw new Error('Restore recovery completion must not precede the original database commit');
  }
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(athleteAnonymizationExecutions).set({
      status: 'COMPLETED',
      completedAt: intent.record.startedAt,
      updatedAt: intent.record.startedAt,
    }).where(and(
      eq(athleteAnonymizationExecutions.id, action.executionId),
      eq(athleteAnonymizationExecutions.tenantId, action.tenantId),
      eq(athleteAnonymizationExecutions.athleteId, action.athleteId),
      eq(athleteAnonymizationExecutions.status, 'DB_COMMITTED'),
    )).returning();
    if (!updated) throw new Error('Restore recovery executor lost the DB_COMMITTED execution state');
    await appendAuditEvent(tx, {
      tenantId: action.tenantId,
      actorRole: 'RESTORE_RECOVERY',
      action: 'restore.anonymization_execution_completed',
      entityType: 'athlete_anonymization_execution',
      entityId: action.executionId,
      source: 'RESTORE_RECOVERY',
      before: { athleteId: action.athleteId, status: 'DB_COMMITTED' },
      after: { athleteId: action.athleteId, status: 'COMPLETED' },
      correlationId: intent.record.planFingerprint,
      occurredAt: intent.record.startedAt,
      recordedAt: intent.record.startedAt,
    });
  });
  return 'APPLIED';
}

function assertExistingNormalizationMatches(
  normalization: Readonly<NonNullable<Awaited<ReturnType<typeof getRestorePrivateRecoveryNormalization>>>>,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
): void {
  if (
    normalization.executionId !== action.executionId
    || normalization.tenantId !== action.tenantId
    || normalization.athleteId !== action.athleteId
    || normalization.backupCutoff !== plan.backupCutoff
    || normalization.planFingerprint !== plan.planFingerprint
    || normalization.actionsFingerprint !== plan.actionsFingerprint
    || normalization.intentSignature !== intent.signature
    || normalization.recoveryStartedAt !== intent.record.startedAt
    || normalization.snapshotStatus !== action.snapshotStatus
    || normalization.action !== 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE'
    || normalization.effectBasis !== 'POST_BACKUP_COMMITTED'
    || normalization.sourceDbCommittedAt !== action.committedAt
    || normalization.normalizedAt < intent.record.startedAt
  ) {
    throw new Error('Restore recovery executor found incompatible existing normalization evidence');
  }
}

async function normalizeReplayedExecution(
  db: Database,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  input: Readonly<ExecuteRestorePrivateRecoveryInput>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
  normalizedAt: string,
): Promise<RestorePrivateRecoveryExecutionActionStatus> {
  const current = await loadExecution(db, action);
  if (current.status !== action.snapshotStatus
    || (current.status !== 'PREPARING' && current.status !== 'ARTIFACTS_STAGED')) {
    throw new Error('Restore recovery normalization must preserve the historical snapshot execution state');
  }
  const existing = await getRestorePrivateRecoveryNormalization(db, action.executionId);
  if (existing) {
    assertExistingNormalizationMatches(existing, action, input.plan, intent);
    return 'ALREADY_APPLIED';
  }
  try {
    const recorded = await recordRestorePrivateRecoveryNormalization(db, {
      executionId: action.executionId,
      plan: input.plan,
      reconciliation: input.reconciliation,
      intentFile: input.intentFile,
      intentKeyFile: input.intentKeyFile,
      roots: input.roots,
      normalizedAt,
    });
    return recorded.created ? 'APPLIED' : 'ALREADY_APPLIED';
  } catch (error) {
    const raced = await getRestorePrivateRecoveryNormalization(db, action.executionId);
    if (raced) {
      assertExistingNormalizationMatches(raced, action, input.plan, intent);
      return 'ALREADY_APPLIED';
    }
    throw error;
  }
}

async function executeAction(
  db: Database,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  input: Readonly<ExecuteRestorePrivateRecoveryInput>,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
  normalizedAt: string,
): Promise<Readonly<RestorePrivateRecoveryExecutionActionResult>> {
  if (action.action === 'ABORT_PREPARING') {
    await assertActiveArtifactsUnchanged(roots, action);
    const status = await abortExecution(db, action, intent);
    return Object.freeze({
      executionId: action.executionId,
      action: action.action,
      status,
      artifactMutationCount: 0,
      terminalEvidence: 'ABORTED_EXECUTION',
    });
  }

  if (action.action === 'RESTORE_ARTIFACTS_AND_ABORT') {
    const artifactMutationCount = await restoreActionArtifacts(roots, action);
    const status = await abortExecution(db, action, intent);
    return Object.freeze({
      executionId: action.executionId,
      action: action.action,
      status: artifactMutationCount > 0 || status === 'APPLIED' ? 'APPLIED' : 'ALREADY_APPLIED',
      artifactMutationCount,
      terminalEvidence: 'ABORTED_EXECUTION',
    });
  }

  if (action.action === 'PURGE_ARTIFACTS_AND_COMPLETE') {
    const artifactMutationCount = await purgeActionArtifacts(roots, action);
    const status = await completeExecution(db, action, intent);
    return Object.freeze({
      executionId: action.executionId,
      action: action.action,
      status: artifactMutationCount > 0 || status === 'APPLIED' ? 'APPLIED' : 'ALREADY_APPLIED',
      artifactMutationCount,
      terminalEvidence: 'COMPLETED_EXECUTION',
    });
  }

  if (action.action === 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE') {
    const artifactMutationCount = await purgeActionArtifacts(roots, action);
    const status = await normalizeReplayedExecution(db, action, input, intent, normalizedAt);
    return Object.freeze({
      executionId: action.executionId,
      action: action.action,
      status: artifactMutationCount > 0 || status === 'APPLIED' ? 'APPLIED' : 'ALREADY_APPLIED',
      artifactMutationCount,
      terminalEvidence: 'RESTORE_NORMALIZATION',
    });
  }

  throw new Error('Restore recovery executor action is unsupported');
}

/**
 * Applies only a previously persisted and cryptographically verified recovery plan to the private
 * restore copy. No planning is performed here. Every action is progress-aware so the same plan and
 * PENDING intent can be safely resumed after a crash.
 */
export async function executeRestorePrivateRecovery(
  db: Database,
  input: Readonly<ExecuteRestorePrivateRecoveryInput>,
): Promise<Readonly<RestorePrivateRecoveryExecutionResult>> {
  verifyRestorePrivateRecoveryPlan(input.plan, input.reconciliation);
  const roots = await verifiedRoots(input.roots);
  const intent = await readVerifiedRestorePrivateRecoveryIntent(
    input.intentFile,
    input.intentKeyFile,
    input.plan,
    input.reconciliation,
  );
  const normalizedAt = input.normalizedAt ?? new Date().toISOString();
  if (!CANONICAL_UTC_TIMESTAMP.test(normalizedAt) || !Number.isFinite(Date.parse(normalizedAt))) {
    throw new Error('Restore recovery executor normalizedAt must be a canonical UTC ISO-8601 timestamp');
  }
  if (normalizedAt < intent.record.startedAt) {
    throw new Error('Restore recovery executor normalizedAt must not precede the signed recovery intent');
  }

  const results: RestorePrivateRecoveryExecutionActionResult[] = [];
  for (const action of input.plan.actions) {
    results.push(await executeAction(db, action, input, roots, intent, normalizedAt));
  }
  const appliedCount = results.filter((item) => item.status === 'APPLIED').length;
  return Object.freeze({
    mode: 'ISOLATED_RESTORE_RECOVERY_EXECUTION',
    backupCutoff: input.plan.backupCutoff,
    planFingerprint: input.plan.planFingerprint,
    recoveryStartedAt: intent.record.startedAt,
    actionCount: results.length,
    appliedCount,
    alreadyAppliedCount: results.length - appliedCount,
    actions: Object.freeze(results),
    promotionAllowed: false,
  });
}
