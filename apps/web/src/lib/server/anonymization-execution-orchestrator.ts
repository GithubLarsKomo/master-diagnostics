import {
  abortAthleteAnonymizationExecution,
  commitStagedAthleteAnonymizationDatabase,
  completeAthleteAnonymizationExecution,
  getAthleteAnonymizationExecution,
  getAthleteAnonymizationExecutionByApproval,
  getAthleteAnonymizationPolicyPreview,
  listAthleteAnonymizationExecutionArtifacts,
  markAthleteAnonymizationArtifactsStaged,
  prepareAthleteAnonymizationExecution,
  validateAthleteAnonymizationApproval,
  type AuditActorContext,
  type Database,
  type GlobalPrivacyCapabilities,
  type StoredAthleteAnonymizationExecution,
} from '@masters/db';
import { db as configuredDb } from '../db';
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

export interface AthleteAnonymizationExecutionInput {
  tenantId: string;
  athleteId: string;
  approvalId: string;
  actor: AuditActorContext;
  globalCapabilities: Readonly<GlobalPrivacyCapabilities>;
}

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
  if (!sameStrings(preview.preview.reportArtifactReferences, manifestReports)
    || !sameStrings(preview.preview.activeTenantExportPackageReferences, manifestExports)) {
    throw new Error('Anonymization artifact manifest no longer matches the current preview');
  }

  return artifactHandles(deps, input.tenantId, execution.id);
}

async function abortAfterSuccessfulRestore(
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
      'Anonymization failed after artifact restore and execution abort also failed',
    );
  }
  throw originalError;
}

async function finalizeCommittedExecution(
  deps: AthleteAnonymizationOrchestratorDependencies,
  input: Pick<AthleteAnonymizationRecoveryInput, 'tenantId' | 'athleteId' | 'executionId' | 'actor'>,
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  const handles = await artifactHandles(deps, input.tenantId, input.executionId);
  await purgeAnonymizationArtifacts(handles, deps.reportStorage, deps.exportStorage);
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
 * Executes or resumes the irreversible athlete workflow. The filesystem and DB
 * boundary is intentionally two-phase:
 * PREPARING -> quarantine -> ARTIFACTS_STAGED -> transactional DB commit ->
 * DB_COMMITTED -> purge -> COMPLETED.
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
    const handles = await requireFreshPreStageState(deps, input, execution, now());
    try {
      staged = await stageAnonymizationArtifacts(
        execution.id,
        handles.reports.map((item) => item.reference),
        handles.tenantExports.map((item) => item.reference),
        deps.reportStorage,
        deps.exportStorage,
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
          await restoreAnonymizationArtifacts(staged, deps.reportStorage, deps.exportStorage);
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
        deps.reportStorage,
        deps.exportStorage,
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
      await restoreAnonymizationArtifacts(staged, deps.reportStorage, deps.exportStorage);
    } catch (restoreError) {
      throw new AggregateError(
        [commitError, restoreError],
        'Anonymization database commit failed and artifact restore was incomplete',
      );
    }
    return abortAfterSuccessfulRestore(deps, input, execution.id, commitError);
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
  };
}
