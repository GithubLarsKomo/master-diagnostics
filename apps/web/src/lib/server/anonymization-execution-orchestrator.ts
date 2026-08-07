import {
  abortAthleteAnonymizationExecution,
  attestGlobalPrivacyCapabilitiesFromEnvironment,
  commitStagedAthleteAnonymizationDatabase,
  completeAthleteAnonymizationExecution,
  getAthleteAnonymizationExecution,
  getAthleteAnonymizationExecutionByApproval,
  getAthleteAnonymizationPolicyPreview,
  getAthleteAnonymizationPrivacyEffectIdentity,
  listAthleteAnonymizationExecutionArtifacts,
  markAthleteAnonymizationArtifactsStaged,
  prepareAthleteAnonymizationExecution,
  validateAthleteAnonymizationApproval,
  type AuditActorContext,
  type Database,
  type GlobalPrivacyCapabilities,
  type RestorePrivacyEffectIdentity,
  type StoredAthleteAnonymizationExecution,
} from '@masters/db';
import { db as configuredDb } from '../db';
import {
  createDataSubjectDeliveryPackageStorage,
  type QuarantinableDataSubjectDeliveryPackageStorage,
} from '../data-subject-delivery-package-storage';
import {
  createReportArtifactStorage,
  type QuarantinableReportArtifactStorage,
} from '../report-artifact-storage';
import {
  createTenantExportPackageStorage,
  type QuarantinableTenantExportPackageStorage,
} from '../tenant-export-package-storage';
import {
  purgeAnonymizationArtifacts,
  restoreAnonymizationArtifacts,
  stageAnonymizationArtifacts,
  type StagedAnonymizationArtifacts,
} from './anonymization-artifact-quarantine';
import {
  abortedAthleteAnonymizationPrivacyEffectRecord,
  committedAthleteAnonymizationPrivacyEffectRecord,
  configuredAthleteAnonymizationPrivacyEffectJournal,
  pendingAthleteAnonymizationPrivacyEffectRecord,
  type AthleteAnonymizationPrivacyEffectJournal,
} from './anonymization-privacy-effect-journal';

export interface AthleteAnonymizationExecutionInput {
  tenantId: string;
  athleteId: string;
  approvalId: string;
  actor: AuditActorContext;
  globalCapabilities: Readonly<GlobalPrivacyCapabilities>;
}

export type ConfiguredAthleteAnonymizationExecutionInput = Omit<
  AthleteAnonymizationExecutionInput,
  'globalCapabilities'
>;

export interface AthleteAnonymizationRecoveryInput {
  tenantId: string;
  athleteId: string;
  executionId: string;
  actor: AuditActorContext;
}

export interface AthleteAnonymizationOrchestratorDependencies {
  db: Database;
  reportStorage: QuarantinableReportArtifactStorage;
  exportStorage: QuarantinableTenantExportPackageStorage;
  dataSubjectExportStorage: QuarantinableDataSubjectDeliveryPackageStorage;
  privacyEffectJournal: AthleteAnonymizationPrivacyEffectJournal;
  now?: () => string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function artifactHandles(
  deps: AthleteAnonymizationOrchestratorDependencies,
  tenantId: string,
  executionId: string,
): Promise<Readonly<StagedAnonymizationArtifacts>> {
  const manifest = await listAthleteAnonymizationExecutionArtifacts(deps.db, tenantId, executionId);
  return Object.freeze({
    executionId,
    reports: Object.freeze(manifest
      .filter((item) => item.kind === 'REPORT')
      .map((item) => Object.freeze({ executionId, reference: item.storageReference }))),
    tenantExports: Object.freeze(manifest
      .filter((item) => item.kind === 'TENANT_EXPORT')
      .map((item) => Object.freeze({ executionId, reference: item.storageReference }))),
    dataSubjectExports: Object.freeze(manifest
      .filter((item) => item.kind === 'DATA_SUBJECT_EXPORT')
      .map((item) => Object.freeze({ executionId, reference: item.storageReference }))),
  });
}

async function requireFreshPreStageState(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: AthleteAnonymizationExecutionInput,
  execution: Readonly<StoredAthleteAnonymizationExecution>,
  assessedAt: string,
): Promise<Readonly<StagedAnonymizationArtifacts>> {
  const validation = await validateAthleteAnonymizationApproval(
    deps.db,
    input.tenantId,
    input.athleteId,
    input.approvalId,
    input.globalCapabilities,
    assessedAt,
  );
  if (!validation.validForExecutionPreparation) {
    throw new Error(`Anonymization approval is not valid immediately before staging: ${validation.blockers.join(', ')}`);
  }

  const [preview, manifest] = await Promise.all([
    getAthleteAnonymizationPolicyPreview(
      deps.db,
      input.tenantId,
      input.athleteId,
      assessedAt,
      input.globalCapabilities,
    ),
    listAthleteAnonymizationExecutionArtifacts(deps.db, input.tenantId, execution.id),
  ]);
  if (!preview.globalPrivacy.readyForIrreversibleProcessing
    || preview.policy.unresolvedScopes.length > 0
    || preview.policy.unresolvedGlobalRequirements.length > 0) {
    throw new Error('Anonymization policy is not ready immediately before staging');
  }

  const manifestReports = manifest.filter((item) => item.kind === 'REPORT').map((item) => item.storageReference);
  const manifestExports = manifest.filter((item) => item.kind === 'TENANT_EXPORT').map((item) => item.storageReference);
  const manifestSubjectExports = manifest
    .filter((item) => item.kind === 'DATA_SUBJECT_EXPORT')
    .map((item) => item.storageReference);
  if (!sameStrings(preview.preview.reportArtifactReferences, manifestReports)
    || !sameStrings(preview.preview.activeTenantExportPackageReferences, manifestExports)
    || !sameStrings(preview.preview.dataSubjectDeliveryPackageReferences, manifestSubjectExports)) {
    throw new Error('Anonymization artifact manifest no longer matches the current preview');
  }

  return artifactHandles(deps, input.tenantId, execution.id);
}

async function requirePrivacyEffectIdentity(
  deps: AthleteAnonymizationOrchestratorDependencies,
  tenantId: string,
  athleteId: string,
  executionId: string,
): Promise<Readonly<RestorePrivacyEffectIdentity>> {
  const effect = await getAthleteAnonymizationPrivacyEffectIdentity(
    deps.db,
    tenantId,
    athleteId,
    executionId,
  );
  if (!effect) throw new Error('Anonymization privacy effect identity is unavailable');
  return effect;
}

async function persistPendingPrivacyEffect(
  deps: AthleteAnonymizationOrchestratorDependencies,
  execution: Readonly<StoredAthleteAnonymizationExecution>,
): Promise<void> {
  if (execution.status !== 'ARTIFACTS_STAGED' || !execution.artifactsStagedAt) {
    throw new Error('ARTIFACTS_STAGED execution with staged timestamp required before PENDING privacy effect');
  }
  const effect = await requirePrivacyEffectIdentity(
    deps,
    execution.tenantId,
    execution.athleteId,
    execution.id,
  );
  await deps.privacyEffectJournal.persist(
    pendingAthleteAnonymizationPrivacyEffectRecord(effect, execution.artifactsStagedAt),
  );
}

async function persistCommittedPrivacyEffect(
  deps: AthleteAnonymizationOrchestratorDependencies,
  execution: Readonly<StoredAthleteAnonymizationExecution>,
): Promise<void> {
  if (execution.status !== 'DB_COMMITTED' || !execution.dbCommittedAt) {
    throw new Error('DB_COMMITTED execution with commit timestamp required before COMMITTED privacy effect');
  }
  const effect = await requirePrivacyEffectIdentity(
    deps,
    execution.tenantId,
    execution.athleteId,
    execution.id,
  );
  await deps.privacyEffectJournal.persist(
    committedAthleteAnonymizationPrivacyEffectRecord(effect, execution.dbCommittedAt),
  );
}

async function persistAbortedPrivacyEffect(
  deps: AthleteAnonymizationOrchestratorDependencies,
  execution: Readonly<StoredAthleteAnonymizationExecution>,
): Promise<void> {
  if (execution.status !== 'ABORTED' || !execution.abortedAt) {
    throw new Error('ABORTED execution with abort timestamp required before ABORTED privacy effect');
  }
  const effect = await requirePrivacyEffectIdentity(
    deps,
    execution.tenantId,
    execution.athleteId,
    execution.id,
  );
  await deps.privacyEffectJournal.persist(
    abortedAthleteAnonymizationPrivacyEffectRecord(effect, execution.abortedAt),
  );
}

async function abortBeforeStaging(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: AthleteAnonymizationExecutionInput,
  executionId: string,
  originalError: unknown,
): Promise<never> {
  try {
    await abortAthleteAnonymizationExecution(
      deps.db,
      input.tenantId,
      input.athleteId,
      executionId,
      input.actor,
      (deps.now ?? (() => new Date().toISOString()))(),
    );
  } catch (abortError) {
    throw new AggregateError(
      [originalError, abortError],
      'Anonymization pre-stage validation failed and execution abort also failed',
    );
  }
  throw originalError;
}

async function abortAfterSuccessfulRestore(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: AthleteAnonymizationExecutionInput,
  executionId: string,
  originalError: unknown,
  privacyEffectPending = false,
): Promise<never> {
  let aborted: Readonly<StoredAthleteAnonymizationExecution>;
  try {
    aborted = await abortAthleteAnonymizationExecution(
      deps.db,
      input.tenantId,
      input.athleteId,
      executionId,
      input.actor,
      (deps.now ?? (() => new Date().toISOString()))(),
    );
  } catch (abortError) {
    throw new AggregateError(
      [originalError, abortError],
      'Anonymization failed after artifact restore and execution abort also failed',
    );
  }

  if (privacyEffectPending) {
    try {
      await persistAbortedPrivacyEffect(deps, aborted);
    } catch (journalError) {
      throw new AggregateError(
        [originalError, journalError],
        'Anonymization database commit failed; artifacts were restored and execution aborted, but privacy effect ABORTED journaling failed',
      );
    }
  }
  throw originalError;
}

async function finalizeCommittedExecution(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: Pick<AthleteAnonymizationRecoveryInput, 'tenantId' | 'athleteId' | 'executionId' | 'actor'>,
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  const committed = await getAthleteAnonymizationExecution(
    deps.db,
    input.tenantId,
    input.athleteId,
    input.executionId,
  );
  if (!committed) throw new Error('Anonymization execution not found during committed finalization');
  if (committed.status === 'COMPLETED') return committed;
  if (committed.status !== 'DB_COMMITTED') {
    throw new Error('DB_COMMITTED anonymization execution required for finalization');
  }

  // The external COMMITTED proof is a hard prerequisite for destructive purge.
  // Its timestamp is the immutable DB commit timestamp so retries are byteidentical.
  await persistCommittedPrivacyEffect(deps, committed);

  const handles = await artifactHandles(deps, input.tenantId, input.executionId);
  await purgeAnonymizationArtifacts(
    handles,
    deps.reportStorage,
    deps.exportStorage,
    deps.dataSubjectExportStorage,
  );
  const completedAt = (deps.now ?? (() => new Date().toISOString()))();
  try {
    return await completeAthleteAnonymizationExecution(
      deps.db,
      input.tenantId,
      input.athleteId,
      input.executionId,
      input.actor,
      completedAt,
    );
  } catch (completionError) {
    const current = await getAthleteAnonymizationExecution(
      deps.db, input.tenantId, input.athleteId, input.executionId,
    );
    if (current?.status === 'COMPLETED') return current;
    throw completionError;
  }
}

/**
 * Executes or resumes the irreversible athlete workflow. The filesystem, durable
 * privacy-effect journal and DB boundary is intentionally ordered:
 * PREPARING -> quarantine -> ARTIFACTS_STAGED -> PENDING -> transactional DB
 * commit -> DB_COMMITTED -> COMMITTED -> purge -> COMPLETED.
 */
export async function executeAthleteAnonymization(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: AthleteAnonymizationExecutionInput,
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  const now = deps.now ?? (() => new Date().toISOString());
  let execution = await getAthleteAnonymizationExecutionByApproval(
    deps.db, input.tenantId, input.athleteId, input.approvalId,
  );

  if (execution?.status === 'COMPLETED') return execution;
  if (execution?.status === 'DB_COMMITTED') {
    return finalizeCommittedExecution(deps, { ...input, executionId: execution.id });
  }
  if (execution?.status === 'ABORTED') {
    throw new Error('Anonymization execution was aborted; a new approval is required');
  }

  if (!execution) {
    execution = await prepareAthleteAnonymizationExecution(
      deps.db,
      input.tenantId,
      input.athleteId,
      input.approvalId,
      input.actor,
      input.globalCapabilities,
      now(),
    );
  }

  let staged: Readonly<StagedAnonymizationArtifacts>;
  if (execution.status === 'PREPARING') {
    let handles: Readonly<StagedAnonymizationArtifacts>;
    try {
      handles = await requireFreshPreStageState(deps, input, execution, now());
    } catch (preStageError) {
      return abortBeforeStaging(deps, input, execution.id, preStageError);
    }

    try {
      staged = await stageAnonymizationArtifacts(
        execution.id,
        handles.reports.map((item) => item.reference),
        handles.tenantExports.map((item) => item.reference),
        handles.dataSubjectExports.map((item) => item.reference),
        deps.reportStorage,
        deps.exportStorage,
        deps.dataSubjectExportStorage,
      );
    } catch (stageError) {
      if (stageError instanceof AggregateError) throw stageError;
      return abortAfterSuccessfulRestore(deps, input, execution.id, stageError);
    }

    try {
      execution = await markAthleteAnonymizationArtifactsStaged(
        deps.db, input.tenantId, input.athleteId, execution.id, input.actor, now(),
      );
    } catch (transitionError) {
      const current = await getAthleteAnonymizationExecution(
        deps.db, input.tenantId, input.athleteId, execution.id,
      );
      if (current && ['ARTIFACTS_STAGED', 'DB_COMMITTED', 'COMPLETED'].includes(current.status)) {
        execution = current;
      } else {
        try {
          await restoreAnonymizationArtifacts(
            staged,
            deps.reportStorage,
            deps.exportStorage,
            deps.dataSubjectExportStorage,
          );
        } catch (restoreError) {
          throw new AggregateError(
            [transitionError, restoreError],
            'Artifact staging succeeded but execution transition failed and restore was incomplete',
          );
        }
        return abortAfterSuccessfulRestore(deps, input, execution.id, transitionError);
      }
    }
  } else {
    const handles = await artifactHandles(deps, input.tenantId, execution.id);
    try {
      staged = await stageAnonymizationArtifacts(
        execution.id,
        handles.reports.map((item) => item.reference),
        handles.tenantExports.map((item) => item.reference),
        handles.dataSubjectExports.map((item) => item.reference),
        deps.reportStorage,
        deps.exportStorage,
        deps.dataSubjectExportStorage,
      );
    } catch (stageError) {
      if (stageError instanceof AggregateError) throw stageError;
      return abortAfterSuccessfulRestore(deps, input, execution.id, stageError);
    }
  }

  if (execution.status === 'DB_COMMITTED' || execution.status === 'COMPLETED') {
    return execution.status === 'COMPLETED'
      ? execution
      : finalizeCommittedExecution(deps, { ...input, executionId: execution.id });
  }

  // A failed PENDING write deliberately leaves ARTIFACTS_STAGED + quarantine
  // intact. No privacy-effective DB mutation has happened, and the same approval
  // can be retried once external journal durability is restored.
  await persistPendingPrivacyEffect(deps, execution);

  try {
    await commitStagedAthleteAnonymizationDatabase(
      deps.db,
      input.tenantId,
      input.athleteId,
      execution.id,
      input.actor,
      input.globalCapabilities,
      now(),
    );
  } catch (commitError) {
    const current = await getAthleteAnonymizationExecution(
      deps.db, input.tenantId, input.athleteId, execution.id,
    );
    if (current?.status === 'DB_COMMITTED' || current?.status === 'COMPLETED') {
      return current.status === 'COMPLETED'
        ? current
        : finalizeCommittedExecution(deps, { ...input, executionId: execution.id });
    }

    try {
      await restoreAnonymizationArtifacts(
        staged,
        deps.reportStorage,
        deps.exportStorage,
        deps.dataSubjectExportStorage,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [commitError, restoreError],
        'Anonymization database commit failed and artifact restore was incomplete',
      );
    }
    return abortAfterSuccessfulRestore(deps, input, execution.id, commitError, true);
  }

  return finalizeCommittedExecution(deps, { ...input, executionId: execution.id });
}

export async function recoverCommittedAthleteAnonymization(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: AthleteAnonymizationRecoveryInput,
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  const execution = await getAthleteAnonymizationExecution(
    deps.db, input.tenantId, input.athleteId, input.executionId,
  );
  if (!execution) throw new Error('Anonymization execution not found');
  if (execution.status === 'COMPLETED') return execution;
  if (execution.status !== 'DB_COMMITTED') {
    throw new Error('Only DB_COMMITTED anonymization executions can use purge recovery');
  }
  return finalizeCommittedExecution(deps, input);
}

export function configuredAnonymizationOrchestratorDependencies(): AthleteAnonymizationOrchestratorDependencies {
  return {
    db: configuredDb,
    reportStorage: createReportArtifactStorage(),
    exportStorage: createTenantExportPackageStorage(),
    dataSubjectExportStorage: createDataSubjectDeliveryPackageStorage(),
    privacyEffectJournal: configuredAthleteAnonymizationPrivacyEffectJournal(),
  };
}

/**
 * Production-oriented entrypoint. Runtime global privacy capabilities are read
 * from the same explicit environment contract as the deployment preflight.
 * Missing or incomplete attestation fails before any athlete DB/file mutation.
 */
export async function executeConfiguredAthleteAnonymization(
  input: ConfiguredAthleteAnonymizationExecutionInput,
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  const attestation = attestGlobalPrivacyCapabilitiesFromEnvironment(process.env);
  if (!attestation.evaluation.readyForIrreversibleProcessing) {
    throw new Error(
      `Global privacy runtime attestation is not ready: ${attestation.evaluation.blockers.join(', ')}`,
    );
  }
  return executeAthleteAnonymization(
    configuredAnonymizationOrchestratorDependencies(),
    { ...input, globalCapabilities: attestation.capabilities },
  );
}
