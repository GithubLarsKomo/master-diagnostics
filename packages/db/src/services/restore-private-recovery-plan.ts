import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { asc, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteAnonymizationExecutionArtifacts } from '../schema';
import type { AthleteAnonymizationExecutionArtifactKind } from './anonymization-execution';
import type { RestorePrivacyArtifactReplayRoots } from './restore-privacy-artifact-replay';
import { restorePrivacyObligationsFingerprint } from './restore-privacy-artifact-replay-manifest';
import {
  RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION,
  type RestorePrivateRecoveryAction,
  type RestorePrivateRecoveryAssessment,
} from './restore-private-recovery-assessment';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVATE_RECOVERY_PLAN_VERSION = 1 as const;

export type RestorePrivateRecoveryArtifactPresence = 'ACTIVE' | 'QUARANTINED' | 'ABSENT';

export interface RestorePrivateRecoveryPlanArtifact {
  readonly kind: AthleteAnonymizationExecutionArtifactKind;
  readonly storageReference: string;
  readonly expectedPresence: RestorePrivateRecoveryArtifactPresence;
}

export interface RestorePrivateRecoveryPlanAction extends RestorePrivateRecoveryAction {
  readonly artifacts: readonly Readonly<RestorePrivateRecoveryPlanArtifact>[];
}

export interface RestorePrivateRecoveryPlan {
  readonly planVersion: typeof RESTORE_PRIVATE_RECOVERY_PLAN_VERSION;
  readonly backupCutoff: string;
  readonly reconciliationStatus: 'CLEAR' | 'REPLAY_REQUIRED';
  readonly ledgerGeneratedAt: string | null;
  readonly ledgerEntriesFingerprint: string | null;
  readonly journalMarkerCount: number;
  readonly obligationsFingerprint: `sha256:${string}`;
  readonly assessmentVersion: typeof RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION;
  readonly assessmentFingerprint: `sha256:${string}`;
  readonly actionCount: number;
  readonly actionsFingerprint: `sha256:${string}`;
  readonly actions: readonly Readonly<RestorePrivateRecoveryPlanAction>[];
  readonly promotionAllowed: false;
  readonly planFingerprint: `sha256:${string}`;
}

export interface PersistedRestorePrivateRecoveryPlan {
  readonly created: boolean;
  readonly plan: Readonly<RestorePrivateRecoveryPlan>;
}

const REPORT_REFERENCE = /^[a-zA-Z0-9/_-]+\.pdf$/;
const TENANT_EXPORT_REFERENCE = /^[a-f0-9-]+\.mde$/;
const DATA_SUBJECT_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const EXECUTION_ID = /^[a-zA-Z0-9-]{8,80}$/;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function actionKey(action: Readonly<RestorePrivateRecoveryAction>): string {
  return action.executionId;
}

function artifactKey(artifact: Readonly<RestorePrivateRecoveryPlanArtifact>): string {
  return [artifact.kind, artifact.storageReference].join('\n');
}

function canonicalAssessment(assessment: Readonly<RestorePrivateRecoveryAssessment>) {
  return {
    assessmentVersion: assessment.assessmentVersion,
    backupCutoff: assessment.backupCutoff,
    status: assessment.status,
    recoveryRequired: assessment.recoveryRequired,
    recoveryReady: assessment.recoveryReady,
    promotionAllowed: assessment.promotionAllowed,
    actions: [...assessment.actions]
      .sort((left, right) => actionKey(left).localeCompare(actionKey(right)))
      .map((action) => ({ ...action })),
    blockers: [...assessment.blockers].map((item) => ({ ...item })),
  };
}

export function restorePrivateRecoveryAssessmentFingerprint(
  assessment: Readonly<RestorePrivateRecoveryAssessment>,
): `sha256:${string}` {
  return sha256(JSON.stringify(canonicalAssessment(assessment)));
}

function canonicalPlanActions(actions: readonly Readonly<RestorePrivateRecoveryPlanAction>[]) {
  return [...actions]
    .sort((left, right) => actionKey(left).localeCompare(actionKey(right)))
    .map((action) => ({
      executionId: action.executionId,
      tenantId: action.tenantId,
      athleteId: action.athleteId,
      snapshotStatus: action.snapshotStatus,
      action: action.action,
      effectBasis: action.effectBasis,
      committedAt: action.committedAt,
      artifactCount: action.artifactCount,
      activeArtifactCount: action.activeArtifactCount,
      quarantinedArtifactCount: action.quarantinedArtifactCount,
      absentArtifactCount: action.absentArtifactCount,
      artifacts: [...action.artifacts]
        .sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)))
        .map((artifact) => ({ ...artifact })),
    }));
}

function planBody(plan: Omit<RestorePrivateRecoveryPlan, 'planFingerprint'>) {
  return {
    planVersion: plan.planVersion,
    backupCutoff: plan.backupCutoff,
    reconciliationStatus: plan.reconciliationStatus,
    ledgerGeneratedAt: plan.ledgerGeneratedAt,
    ledgerEntriesFingerprint: plan.ledgerEntriesFingerprint,
    journalMarkerCount: plan.journalMarkerCount,
    obligationsFingerprint: plan.obligationsFingerprint,
    assessmentVersion: plan.assessmentVersion,
    assessmentFingerprint: plan.assessmentFingerprint,
    actionCount: plan.actionCount,
    actionsFingerprint: plan.actionsFingerprint,
    actions: canonicalPlanActions(plan.actions),
    promotionAllowed: plan.promotionAllowed,
  };
}

function planFingerprint(plan: Omit<RestorePrivateRecoveryPlan, 'planFingerprint'>): `sha256:${string}` {
  return sha256(JSON.stringify(planBody(plan)));
}

function assertAssessmentReady(assessment: Readonly<RestorePrivateRecoveryAssessment>): void {
  if (assessment.assessmentVersion !== RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION) {
    throw new Error('Restore private recovery assessment version is unsupported');
  }
  if (
    assessment.status !== 'RECOVERY_READY'
    || !assessment.recoveryRequired
    || !assessment.recoveryReady
    || assessment.promotionAllowed !== false
    || assessment.blockers.length !== 0
    || assessment.actions.length === 0
  ) {
    throw new Error('Restore private recovery plan requires an unblocked RECOVERY_READY assessment');
  }
  const canonicalActions = [...assessment.actions].sort((left, right) => actionKey(left).localeCompare(actionKey(right)));
  if (JSON.stringify(canonicalActions) !== JSON.stringify(assessment.actions)) {
    throw new Error('Restore private recovery assessment actions are not canonical');
  }
  if (new Set(assessment.actions.map((item) => item.executionId)).size !== assessment.actions.length) {
    throw new Error('Restore private recovery assessment contains duplicate execution actions');
  }
}

function assertSafeReference(
  kind: AthleteAnonymizationExecutionArtifactKind,
  tenantId: string,
  reference: string,
): void {
  if (!reference || reference.startsWith('/') || reference.includes('..') || reference.includes('\\')) {
    throw new Error('Restore private recovery artifact reference is unsafe');
  }
  if (kind === 'REPORT') {
    if (!REPORT_REFERENCE.test(reference) || !reference.startsWith(`${tenantId}/`)) {
      throw new Error('Restore private recovery report reference is unsafe or outside tenant scope');
    }
    return;
  }
  if (kind === 'TENANT_EXPORT') {
    if (!TENANT_EXPORT_REFERENCE.test(reference)) {
      throw new Error('Restore private recovery tenant export reference is unsafe');
    }
    return;
  }
  if (kind === 'DATA_SUBJECT_EXPORT') {
    if (!DATA_SUBJECT_REFERENCE.test(reference)) {
      throw new Error('Restore private recovery data subject reference is unsafe');
    }
    return;
  }
  throw new Error('Restore private recovery artifact kind is unsupported');
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

async function assertRootDirectory(root: string, label: string): Promise<string> {
  if (!root.trim() || !isAbsolute(root)) throw new Error(`${label} must be an absolute path`);
  const resolved = resolve(root);
  const stat = await lstatIfPresent(resolved);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return resolved;
}

async function verifiedRoots(roots: Readonly<RestorePrivacyArtifactReplayRoots>) {
  const reportRoot = await assertRootDirectory(roots.reportRoot, 'Restore private recovery report root');
  const tenantExportRoot = await assertRootDirectory(
    roots.tenantExportRoot,
    'Restore private recovery tenant export root',
  );
  const dataSubjectDeliveryRoot = await assertRootDirectory(
    roots.dataSubjectDeliveryRoot,
    'Restore private recovery data subject delivery root',
  );
  const pairs: readonly (readonly [string, string])[] = [
    [reportRoot, tenantExportRoot],
    [reportRoot, dataSubjectDeliveryRoot],
    [tenantExportRoot, dataSubjectDeliveryRoot],
  ];
  for (const [left, right] of pairs) {
    if (nestedPath(left, right) || nestedPath(right, left)) {
      throw new Error('Restore private recovery artifact roots must be distinct non-overlapping directories');
    }
  }
  return Object.freeze({ reportRoot, tenantExportRoot, dataSubjectDeliveryRoot });
}

function rootForKind(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  kind: AthleteAnonymizationExecutionArtifactKind,
): string {
  if (kind === 'REPORT') return roots.reportRoot;
  if (kind === 'TENANT_EXPORT') return roots.tenantExportRoot;
  return roots.dataSubjectDeliveryRoot;
}

async function pathState(root: string, relativeReference: string): Promise<'FILE' | 'ABSENT'> {
  const target = resolve(root, relativeReference);
  if (!nestedPath(root, target) || target === root) {
    throw new Error('Restore private recovery artifact target escapes its private storage root');
  }
  let current = root;
  const parts = relativeReference.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstatIfPresent(current);
    if (!stat) return 'ABSENT';
    if (stat.isSymbolicLink()) {
      throw new Error('Restore private recovery refuses symlink-backed artifact paths');
    }
    const finalPart = index === parts.length - 1;
    if (!finalPart && !stat.isDirectory()) {
      throw new Error('Restore private recovery artifact parent path is not a directory');
    }
    if (finalPart && !stat.isFile()) {
      throw new Error('Restore private recovery artifact target is not a regular file');
    }
  }
  return 'FILE';
}

async function inspectArtifact(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  executionId: string,
  tenantId: string,
  kind: AthleteAnonymizationExecutionArtifactKind,
  storageReference: string,
): Promise<Readonly<RestorePrivateRecoveryPlanArtifact>> {
  if (!EXECUTION_ID.test(executionId)) throw new Error('Restore private recovery execution ID is invalid');
  assertSafeReference(kind, tenantId, storageReference);
  const root = rootForKind(roots, kind);
  const [active, quarantined] = await Promise.all([
    pathState(root, storageReference),
    pathState(root, join('.anonymization-quarantine', executionId, storageReference)),
  ]);
  if (active === 'FILE' && quarantined === 'FILE') {
    throw new Error('Restore private recovery artifact exists both active and quarantined');
  }
  return Object.freeze({
    kind,
    storageReference,
    expectedPresence: active === 'FILE' ? 'ACTIVE' : quarantined === 'FILE' ? 'QUARANTINED' : 'ABSENT',
  });
}

function assertActionArtifactsMatchAssessment(
  action: Readonly<RestorePrivateRecoveryPlanAction>,
  assessmentAction: Readonly<RestorePrivateRecoveryAction>,
): void {
  const scalarFields: readonly (keyof RestorePrivateRecoveryAction)[] = [
    'executionId',
    'tenantId',
    'athleteId',
    'snapshotStatus',
    'action',
    'effectBasis',
    'committedAt',
    'artifactCount',
    'activeArtifactCount',
    'quarantinedArtifactCount',
    'absentArtifactCount',
  ];
  for (const field of scalarFields) {
    if (action[field] !== assessmentAction[field]) {
      throw new Error('Restore private recovery plan action no longer matches its assessment');
    }
  }
  if (action.artifactCount !== action.artifacts.length) {
    throw new Error('Restore private recovery plan artifact count is invalid');
  }
  const active = action.artifacts.filter((item) => item.expectedPresence === 'ACTIVE').length;
  const quarantined = action.artifacts.filter((item) => item.expectedPresence === 'QUARANTINED').length;
  const absent = action.artifacts.filter((item) => item.expectedPresence === 'ABSENT').length;
  if (
    active !== action.activeArtifactCount
    || quarantined !== action.quarantinedArtifactCount
    || absent !== action.absentArtifactCount
  ) {
    throw new Error('Restore private recovery plan artifact presence counts are invalid');
  }
  const canonicalArtifacts = [...action.artifacts].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)));
  if (JSON.stringify(canonicalArtifacts) !== JSON.stringify(action.artifacts)) {
    throw new Error('Restore private recovery plan artifacts are not canonical');
  }
  if (new Set(action.artifacts.map((item) => artifactKey(item))).size !== action.artifacts.length) {
    throw new Error('Restore private recovery plan contains duplicate artifacts');
  }
  for (const artifact of action.artifacts) assertSafeReference(artifact.kind, action.tenantId, artifact.storageReference);

  if (action.action === 'ABORT_PREPARING' && (quarantined > 0 || absent > 0)) {
    throw new Error('ABORT_PREPARING recovery plan contains a non-active artifact');
  }
  if (action.action === 'RESTORE_ARTIFACTS_AND_ABORT' && absent > 0) {
    throw new Error('RESTORE_ARTIFACTS_AND_ABORT recovery plan contains an absent artifact');
  }
  if (
    (action.action === 'PURGE_ARTIFACTS_AND_COMPLETE'
      || action.action === 'PURGE_REPLAYED_ARTIFACTS_AND_NORMALIZE')
    && active > 0
  ) {
    throw new Error('Forward-only restore recovery plan contains an active artifact');
  }
}

export function verifyRestorePrivateRecoveryPlan(
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): void {
  if (reconciliation.status === 'BLOCKED' || !reconciliation.reconciliationReady) {
    throw new Error('Restore private recovery plan cannot be verified against blocked reconciliation');
  }
  if (plan.planVersion !== RESTORE_PRIVATE_RECOVERY_PLAN_VERSION) {
    throw new Error('Restore private recovery plan version is unsupported');
  }
  if (
    plan.backupCutoff !== reconciliation.backupCutoff
    || plan.reconciliationStatus !== reconciliation.status
    || plan.ledgerGeneratedAt !== (reconciliation.ledger?.generatedAt ?? null)
    || plan.ledgerEntriesFingerprint !== (reconciliation.ledger?.entriesFingerprint ?? null)
    || plan.journalMarkerCount !== reconciliation.journalMarkerCount
    || plan.obligationsFingerprint !== restorePrivacyObligationsFingerprint(reconciliation.obligations)
  ) {
    throw new Error('Restore private recovery plan evidence binding does not match reconciliation');
  }
  if (
    plan.assessmentVersion !== RESTORE_PRIVATE_RECOVERY_ASSESSMENT_VERSION
    || plan.promotionAllowed !== false
    || !SHA256_FINGERPRINT.test(plan.assessmentFingerprint)
    || !SHA256_FINGERPRINT.test(plan.actionsFingerprint)
    || !SHA256_FINGERPRINT.test(plan.obligationsFingerprint)
    || !SHA256_FINGERPRINT.test(plan.planFingerprint)
  ) {
    throw new Error('Restore private recovery plan metadata is invalid');
  }
  if (!Array.isArray(plan.actions) || plan.actionCount !== plan.actions.length || plan.actions.length === 0) {
    throw new Error('Restore private recovery plan action count is invalid');
  }
  const canonicalActions = canonicalPlanActions(plan.actions);
  if (JSON.stringify(canonicalActions) !== JSON.stringify(plan.actions)) {
    throw new Error('Restore private recovery plan actions are not canonical');
  }
  if (new Set(plan.actions.map((item) => item.executionId)).size !== plan.actions.length) {
    throw new Error('Restore private recovery plan contains duplicate execution actions');
  }
  if (sha256(JSON.stringify(canonicalActions)) !== plan.actionsFingerprint) {
    throw new Error('Restore private recovery plan actions fingerprint does not match its actions');
  }
  for (const action of plan.actions) {
    const syntheticAssessmentAction: RestorePrivateRecoveryAction = {
      executionId: action.executionId,
      tenantId: action.tenantId,
      athleteId: action.athleteId,
      snapshotStatus: action.snapshotStatus,
      action: action.action,
      effectBasis: action.effectBasis,
      committedAt: action.committedAt,
      artifactCount: action.artifactCount,
      activeArtifactCount: action.activeArtifactCount,
      quarantinedArtifactCount: action.quarantinedArtifactCount,
      absentArtifactCount: action.absentArtifactCount,
    };
    assertActionArtifactsMatchAssessment(action, syntheticAssessmentAction);
  }
  const { planFingerprint: _fingerprint, ...withoutFingerprint } = plan;
  if (planFingerprint(withoutFingerprint) !== plan.planFingerprint) {
    throw new Error('Restore private recovery plan fingerprint does not match its content');
  }
}

export function verifyRestorePrivateRecoveryPlanMatchesAssessment(
  plan: Readonly<RestorePrivateRecoveryPlan>,
  assessment: Readonly<RestorePrivateRecoveryAssessment>,
): void {
  assertAssessmentReady(assessment);
  if (
    plan.backupCutoff !== assessment.backupCutoff
    || plan.assessmentVersion !== assessment.assessmentVersion
    || plan.assessmentFingerprint !== restorePrivateRecoveryAssessmentFingerprint(assessment)
    || plan.actionCount !== assessment.actions.length
  ) {
    throw new Error('Restore private recovery plan does not match its recovery assessment');
  }
  for (const [index, action] of plan.actions.entries()) {
    const assessed = assessment.actions[index];
    if (!assessed) throw new Error('Restore private recovery plan action is missing its assessment');
    assertActionArtifactsMatchAssessment(action, assessed);
  }
}

/**
 * Converts an already fail-closed RECOVERY_READY assessment into a durable, exact mutation plan.
 * Every immutable execution-artifact reference and its current ACTIVE/QUARANTINED/ABSENT state is
 * captured so a later executor can resume from this plan after a crash instead of reclassifying a
 * partially mutated filesystem.
 */
export async function buildRestorePrivateRecoveryPlan(
  db: Database,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  assessment: Readonly<RestorePrivateRecoveryAssessment>,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
): Promise<Readonly<RestorePrivateRecoveryPlan>> {
  assertAssessmentReady(assessment);
  if (
    reconciliation.status === 'BLOCKED'
    || !reconciliation.reconciliationReady
    || reconciliation.backupCutoff !== assessment.backupCutoff
  ) {
    throw new Error('Restore private recovery plan requires matching unblocked reconciliation');
  }

  const checkedRoots = await verifiedRoots(roots);
  const executionIds = assessment.actions.map((item) => item.executionId);
  const artifactRows = await db.select().from(athleteAnonymizationExecutionArtifacts).where(
    inArray(athleteAnonymizationExecutionArtifacts.executionId, executionIds),
  ).orderBy(
    asc(athleteAnonymizationExecutionArtifacts.executionId),
    asc(athleteAnonymizationExecutionArtifacts.kind),
    asc(athleteAnonymizationExecutionArtifacts.storageReference),
  );
  const rowsByExecution = new Map<string, typeof artifactRows>();
  for (const row of artifactRows) {
    const current = rowsByExecution.get(row.executionId) ?? [];
    current.push(row);
    rowsByExecution.set(row.executionId, current);
  }

  const actions: RestorePrivateRecoveryPlanAction[] = [];
  for (const assessed of assessment.actions) {
    const rows = rowsByExecution.get(assessed.executionId) ?? [];
    const artifacts: RestorePrivateRecoveryPlanArtifact[] = [];
    for (const row of rows) {
      if (row.tenantId !== assessed.tenantId) {
        throw new Error('Restore private recovery plan artifact crosses execution tenant scope');
      }
      artifacts.push(await inspectArtifact(
        checkedRoots,
        assessed.executionId,
        assessed.tenantId,
        row.kind,
        row.storageReference,
      ));
    }
    artifacts.sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)));
    const action = Object.freeze({
      ...assessed,
      artifacts: Object.freeze(artifacts),
    });
    assertActionArtifactsMatchAssessment(action, assessed);
    actions.push(action);
  }
  actions.sort((left, right) => actionKey(left).localeCompare(actionKey(right)));
  const frozenActions = Object.freeze(actions);
  const body = Object.freeze({
    planVersion: RESTORE_PRIVATE_RECOVERY_PLAN_VERSION,
    backupCutoff: assessment.backupCutoff,
    reconciliationStatus: reconciliation.status,
    ledgerGeneratedAt: reconciliation.ledger?.generatedAt ?? null,
    ledgerEntriesFingerprint: reconciliation.ledger?.entriesFingerprint ?? null,
    journalMarkerCount: reconciliation.journalMarkerCount,
    obligationsFingerprint: restorePrivacyObligationsFingerprint(reconciliation.obligations),
    assessmentVersion: assessment.assessmentVersion,
    assessmentFingerprint: restorePrivateRecoveryAssessmentFingerprint(assessment),
    actionCount: frozenActions.length,
    actionsFingerprint: sha256(JSON.stringify(canonicalPlanActions(frozenActions))),
    actions: frozenActions,
    promotionAllowed: false as const,
  });
  const plan = Object.freeze({ ...body, planFingerprint: planFingerprint(body) });
  verifyRestorePrivateRecoveryPlan(plan, reconciliation);
  verifyRestorePrivateRecoveryPlanMatchesAssessment(plan, assessment);
  return plan;
}

export async function readVerifiedRestorePrivateRecoveryPlanIfPresent(
  filePath: string,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<RestorePrivateRecoveryPlan> | null> {
  let serialized: string;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: RestorePrivateRecoveryPlan;
  try {
    parsed = JSON.parse(serialized) as RestorePrivateRecoveryPlan;
  } catch (error) {
    throw new Error('Restore private recovery plan is not valid JSON', { cause: error });
  }
  verifyRestorePrivateRecoveryPlan(parsed, reconciliation);
  return Object.freeze(parsed);
}

export async function persistRestorePrivateRecoveryPlan(
  filePath: string,
  plan: Readonly<RestorePrivateRecoveryPlan>,
): Promise<Readonly<PersistedRestorePrivateRecoveryPlan>> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  try {
    await writeFile(filePath, serialized, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ created: true, plan });
  } catch (error) {
    const existing = await readFile(filePath, 'utf8').catch(() => null);
    if (existing === serialized) {
      await chmod(filePath, 0o600);
      return Object.freeze({ created: false, plan });
    }
    if (existing !== null) {
      throw new Error('Restore private recovery plan already exists with different content', { cause: error });
    }
    throw error;
  }
}
