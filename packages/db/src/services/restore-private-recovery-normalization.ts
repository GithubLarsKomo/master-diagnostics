import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  restorePrivateRecoveryNormalizations,
  type RestorePrivateRecoveryNormalizationRow,
} from '../schema';
import type { RestorePrivacyArtifactReplayRoots } from './restore-privacy-artifact-replay';
import { readVerifiedRestorePrivateRecoveryIntent } from './restore-private-recovery-intent';
import {
  verifyRestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlanAction,
} from './restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface RecordRestorePrivateRecoveryNormalizationInput {
  readonly executionId: string;
  readonly plan: Readonly<RestorePrivateRecoveryPlan>;
  readonly reconciliation: Readonly<RestorePrivacyReconciliationReport>;
  readonly intentFile: string;
  readonly intentKeyFile: string;
  readonly roots: Readonly<RestorePrivacyArtifactReplayRoots>;
  readonly normalizedAt: string;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

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
  const reportRoot = await verifiedRoot(roots.reportRoot, 'Restore recovery normalization report root');
  const tenantExportRoot = await verifiedRoot(
    roots.tenantExportRoot,
    'Restore recovery normalization tenant export root',
  );
  const dataSubjectDeliveryRoot = await verifiedRoot(
    roots.dataSubjectDeliveryRoot,
    'Restore recovery normalization data subject delivery root',
  );
  const pairs: readonly (readonly [string, string])[] = [
    [reportRoot, tenantExportRoot],
    [reportRoot, dataSubjectDeliveryRoot],
    [tenantExportRoot, dataSubjectDeliveryRoot],
  ];
  for (const [left, right] of pairs) {
    if (nestedPath(left, right) || nestedPath(right, left)) {
      throw new Error('Restore recovery normalization roots must be distinct non-overlapping directories');
    }
  }
  return Object.freeze({ reportRoot, tenantExportRoot, dataSubjectDeliveryRoot });
}

function rootForKind(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  kind: RestorePrivateRecoveryPlanAction['artifacts'][number]['kind'],
): string {
  if (kind === 'REPORT') return roots.reportRoot;
  if (kind === 'TENANT_EXPORT') return roots.tenantExportRoot;
  return roots.dataSubjectDeliveryRoot;
}

async function assertPathAbsent(root: string, relativeReference: string): Promise<void> {
  const target = resolve(root, relativeReference);
  if (!nestedPath(root, target) || target === root) {
    throw new Error('Restore recovery normalization artifact path escapes its private storage root');
  }
  let current = root;
  for (const part of relativeReference.split('/')) {
    current = join(current, part);
    const stat = await lstatIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error('Restore recovery normalization refuses symlink-backed artifact paths');
    }
  }
  throw new Error('Restore recovery normalization requires all planned artifacts to be absent');
}

async function assertActionArtifactsAbsent(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  action: Readonly<RestorePrivateRecoveryPlanAction>,
): Promise<void> {
  const checked = await verifiedRoots(roots);
  for (const artifact of action.artifacts) {
    const root = rootForKind(checked, artifact.kind);
    await assertPathAbsent(root, artifact.storageReference);
    await assertPathAbsent(
      root,
      join('.anonymization-quarantine', action.executionId, artifact.storageReference),
    );
  }
}

function sameNormalization(
  left: Readonly<RestorePrivateRecoveryNormalizationRow>,
  right: Readonly<RestorePrivateRecoveryNormalizationRow>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function existingNormalization(
  db: Database,
  executionId: string,
): Promise<Readonly<RestorePrivateRecoveryNormalizationRow> | null> {
  const rows = await db.select().from(restorePrivateRecoveryNormalizations).where(
    eq(restorePrivateRecoveryNormalizations.executionId, executionId),
  ).limit(1);
  return rows[0] ?? null;
}

/**
 * Writes immutable terminal evidence for the one recovery class that cannot safely use the normal
 * anonymization lifecycle: an older PREPARING/ARTIFACTS_STAGED snapshot whose same execution is
 * cryptographically proven to have COMMITTED after the backup and has already been DB-replayed.
 *
 * The historical execution row is deliberately left untouched. All plan-bound active/quarantined
 * artifacts must already be absent before this evidence can be recorded.
 */
export async function recordRestorePrivateRecoveryNormalization(
  db: Database,
  input: Readonly<RecordRestorePrivateRecoveryNormalizationInput>,
): Promise<Readonly<{ created: boolean; normalization: RestorePrivateRecoveryNormalizationRow }>> {
  verifyRestorePrivateRecoveryPlan(input.plan, input.reconciliation);
  assertCanonicalTimestamp(input.normalizedAt, 'Restore private recovery normalizedAt');

  const action = input.plan.actions.find((item) => item.executionId === input.executionId);
  if (!action) throw new Error('Restore private recovery normalization execution is not in the recovery plan');
  if (
    action.action !== 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE'
    || action.effectBasis !== 'POST_BACKUP_COMMITTED'
    || (action.snapshotStatus !== 'PREPARING' && action.snapshotStatus !== 'ARTIFACTS_STAGED')
    || !action.committedAt
  ) {
    throw new Error('Restore private recovery normalization requires a post-backup committed forward-only action');
  }

  const obligation = input.reconciliation.obligations.find((item) => item.executionId === action.executionId);
  if (!obligation || obligation.dbCommittedAt !== action.committedAt) {
    throw new Error('Restore private recovery normalization lacks matching signed committed obligation');
  }

  const intent = await readVerifiedRestorePrivateRecoveryIntent(
    input.intentFile,
    input.intentKeyFile,
    input.plan,
    input.reconciliation,
  );
  if (input.normalizedAt < intent.record.startedAt) {
    throw new Error('Restore private recovery normalization must not precede its signed recovery intent');
  }

  await assertActionArtifactsAbsent(input.roots, action);

  const normalization = Object.freeze({
    executionId: action.executionId,
    tenantId: action.tenantId,
    athleteId: action.athleteId,
    backupCutoff: input.plan.backupCutoff,
    planFingerprint: input.plan.planFingerprint,
    actionsFingerprint: input.plan.actionsFingerprint,
    intentSignature: intent.signature,
    recoveryStartedAt: intent.record.startedAt,
    snapshotStatus: action.snapshotStatus,
    action: 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE' as const,
    effectBasis: 'POST_BACKUP_COMMITTED' as const,
    sourceDbCommittedAt: action.committedAt,
    normalizedAt: input.normalizedAt,
    createdAt: input.normalizedAt,
  }) satisfies RestorePrivateRecoveryNormalizationRow;

  const current = await existingNormalization(db, action.executionId);
  if (current) {
    if (!sameNormalization(current, normalization)) {
      throw new Error('Restore private recovery normalization already exists with different content');
    }
    return Object.freeze({ created: false, normalization: current });
  }

  try {
    await db.insert(restorePrivateRecoveryNormalizations).values(normalization);
    return Object.freeze({ created: true, normalization });
  } catch (error) {
    const raced = await existingNormalization(db, action.executionId);
    if (raced && sameNormalization(raced, normalization)) {
      return Object.freeze({ created: false, normalization: raced });
    }
    throw error;
  }
}

export async function getRestorePrivateRecoveryNormalization(
  db: Database,
  executionId: string,
): Promise<Readonly<RestorePrivateRecoveryNormalizationRow> | null> {
  return existingNormalization(db, executionId);
}
