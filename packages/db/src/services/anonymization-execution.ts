import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteAnonymizationExecutionArtifacts,
  athleteAnonymizationExecutions,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import { validateAthleteAnonymizationApproval } from './anonymization-approval';
import { getAthleteAnonymizationPolicyPreview } from './anonymization-policy';
import type { GlobalPrivacyCapabilities } from './global-privacy-policy';

export const ANONYMIZATION_EXECUTION_VERSION = 1 as const;

export type AthleteAnonymizationExecutionStatus =
  | 'PREPARING'
  | 'ARTIFACTS_STAGED'
  | 'DB_COMMITTED'
  | 'COMPLETED'
  | 'ABORTED';

export type AthleteAnonymizationExecutionArtifactKind =
  | 'REPORT'
  | 'TENANT_EXPORT'
  | 'DATA_SUBJECT_EXPORT';

export interface StoredAthleteAnonymizationExecution {
  id: string;
  tenantId: string;
  athleteId: string;
  approvalId: string;
  executionVersion: typeof ANONYMIZATION_EXECUTION_VERSION;
  status: AthleteAnonymizationExecutionStatus;
  preparedByUserId: string;
  preparedAt: string;
  artifactsStagedAt: string | null;
  dbCommittedAt: string | null;
  completedAt: string | null;
  abortedAt: string | null;
}

export interface StoredAthleteAnonymizationExecutionArtifact {
  id: string;
  tenantId: string;
  executionId: string;
  kind: AthleteAnonymizationExecutionArtifactKind;
  storageReference: string;
  createdAt: string;
}

function stored(
  row: typeof athleteAnonymizationExecutions.$inferSelect,
): Readonly<StoredAthleteAnonymizationExecution> {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    athleteId: row.athleteId,
    approvalId: row.approvalId,
    executionVersion: ANONYMIZATION_EXECUTION_VERSION,
    status: row.status,
    preparedByUserId: row.preparedByUserId,
    preparedAt: row.preparedAt,
    artifactsStagedAt: row.artifactsStagedAt,
    dbCommittedAt: row.dbCommittedAt,
    completedAt: row.completedAt,
    abortedAt: row.abortedAt,
  });
}

function storedArtifact(
  row: typeof athleteAnonymizationExecutionArtifacts.$inferSelect,
): Readonly<StoredAthleteAnonymizationExecutionArtifact> {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    executionId: row.executionId,
    kind: row.kind,
    storageReference: row.storageReference,
    createdAt: row.createdAt,
  });
}

export async function getAthleteAnonymizationExecution(
  db: Database,
  tenantId: string,
  athleteId: string,
  executionId: string,
): Promise<Readonly<StoredAthleteAnonymizationExecution> | null> {
  const [row] = await db.select().from(athleteAnonymizationExecutions).where(and(
    eq(athleteAnonymizationExecutions.id, executionId),
    eq(athleteAnonymizationExecutions.tenantId, tenantId),
    eq(athleteAnonymizationExecutions.athleteId, athleteId),
  )).limit(1);
  return row ? stored(row) : null;
}

export async function getAthleteAnonymizationExecutionByApproval(
  db: Database,
  tenantId: string,
  athleteId: string,
  approvalId: string,
): Promise<Readonly<StoredAthleteAnonymizationExecution> | null> {
  const [row] = await db.select().from(athleteAnonymizationExecutions).where(and(
    eq(athleteAnonymizationExecutions.approvalId, approvalId),
    eq(athleteAnonymizationExecutions.tenantId, tenantId),
    eq(athleteAnonymizationExecutions.athleteId, athleteId),
  )).limit(1);
  return row ? stored(row) : null;
}

export async function listAthleteAnonymizationExecutionArtifacts(
  db: Database,
  tenantId: string,
  executionId: string,
): Promise<ReadonlyArray<Readonly<StoredAthleteAnonymizationExecutionArtifact>>> {
  const rows = await db.select().from(athleteAnonymizationExecutionArtifacts).where(and(
    eq(athleteAnonymizationExecutionArtifacts.tenantId, tenantId),
    eq(athleteAnonymizationExecutionArtifacts.executionId, executionId),
  )).orderBy(
    asc(athleteAnonymizationExecutionArtifacts.kind),
    asc(athleteAnonymizationExecutionArtifacts.storageReference),
  );
  return Object.freeze(rows.map(storedArtifact));
}

export async function tenantHasActiveAnonymizationExecution(
  db: Database,
  tenantId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: athleteAnonymizationExecutions.id })
    .from(athleteAnonymizationExecutions)
    .where(and(
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      inArray(athleteAnonymizationExecutions.status, ['PREPARING', 'ARTIFACTS_STAGED']),
    ))
    .limit(1);
  return Boolean(row);
}

export async function markAthleteAnonymizationArtifactsStaged(
  db: Database,
  tenantId: string,
  athleteId: string,
  executionId: string,
  actor: AuditActorContext,
  stagedAt = new Date().toISOString(),
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(athleteAnonymizationExecutions).set({
      status: 'ARTIFACTS_STAGED', artifactsStagedAt: stagedAt, updatedAt: stagedAt,
    }).where(and(
      eq(athleteAnonymizationExecutions.id, executionId),
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      eq(athleteAnonymizationExecutions.athleteId, athleteId),
      eq(athleteAnonymizationExecutions.status, 'PREPARING'),
    )).returning();
    if (!updated) throw new Error('PREPARING anonymization execution required');
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.anonymization_artifacts_staged',
      entityType: 'athlete_anonymization_execution',
      entityId: executionId,
      source: 'SYSTEM',
      after: { athleteId, status: 'ARTIFACTS_STAGED' },
      occurredAt: stagedAt,
    });
    return stored(updated);
  });
}

export async function abortAthleteAnonymizationExecution(
  db: Database,
  tenantId: string,
  athleteId: string,
  executionId: string,
  actor: AuditActorContext,
  abortedAt = new Date().toISOString(),
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(athleteAnonymizationExecutions).set({
      status: 'ABORTED', abortedAt, updatedAt: abortedAt,
    }).where(and(
      eq(athleteAnonymizationExecutions.id, executionId),
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      eq(athleteAnonymizationExecutions.athleteId, athleteId),
      inArray(athleteAnonymizationExecutions.status, ['PREPARING', 'ARTIFACTS_STAGED']),
    )).returning();
    if (!updated) throw new Error('Abortable anonymization execution required');
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.anonymization_execution_aborted',
      entityType: 'athlete_anonymization_execution',
      entityId: executionId,
      source: 'SYSTEM',
      after: { athleteId, status: 'ABORTED' },
      occurredAt: abortedAt,
    });
    return stored(updated);
  });
}

export async function completeAthleteAnonymizationExecution(
  db: Database,
  tenantId: string,
  athleteId: string,
  executionId: string,
  actor: AuditActorContext,
  completedAt = new Date().toISOString(),
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(athleteAnonymizationExecutions).set({
      status: 'COMPLETED', completedAt, updatedAt: completedAt,
    }).where(and(
      eq(athleteAnonymizationExecutions.id, executionId),
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      eq(athleteAnonymizationExecutions.athleteId, athleteId),
      eq(athleteAnonymizationExecutions.status, 'DB_COMMITTED'),
    )).returning();
    if (!updated) throw new Error('DB_COMMITTED anonymization execution required');
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.anonymization_completed',
      entityType: 'athlete_anonymization_execution',
      entityId: executionId,
      source: 'SYSTEM',
      after: { athleteId, status: 'COMPLETED' },
      occurredAt: completedAt,
    });
    return stored(updated);
  });
}

/**
 * Creates the durable preparation record and its immutable external-artifact
 * manifest for one approved irreversible run. This is still non-destructive.
 */
export async function prepareAthleteAnonymizationExecution(
  db: Database,
  tenantId: string,
  athleteId: string,
  approvalId: string,
  actor: AuditActorContext,
  globalCapabilities: Readonly<GlobalPrivacyCapabilities>,
  preparedAt = new Date().toISOString(),
): Promise<Readonly<StoredAthleteAnonymizationExecution>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  if (!Number.isFinite(Date.parse(preparedAt))) throw new Error('Preparation time must be a valid ISO-8601 timestamp');

  const validation = await validateAthleteAnonymizationApproval(
    db, tenantId, athleteId, approvalId, globalCapabilities, preparedAt,
  );
  if (!validation.validForExecutionPreparation) {
    throw new Error(`Anonymization approval is not valid for execution preparation: ${validation.blockers.join(', ')}`);
  }

  const [existing] = await db.select().from(athleteAnonymizationExecutions).where(
    eq(athleteAnonymizationExecutions.approvalId, approvalId),
  ).limit(1);
  if (existing) {
    if (existing.tenantId !== tenantId || existing.athleteId !== athleteId) {
      throw new Error('Existing anonymization execution does not match tenant athlete boundary');
    }
    return stored(existing);
  }

  const policyPreview = await getAthleteAnonymizationPolicyPreview(
    db, tenantId, athleteId, preparedAt, globalCapabilities,
  );
  if (!policyPreview.globalPrivacy.readyForIrreversibleProcessing
    || policyPreview.policy.unresolvedScopes.length > 0
    || policyPreview.policy.unresolvedGlobalRequirements.length > 0) {
    throw new Error('Anonymization policy changed during execution preparation');
  }

  const row = {
    id: crypto.randomUUID(), tenantId, athleteId, approvalId,
    executionVersion: ANONYMIZATION_EXECUTION_VERSION, status: 'PREPARING' as const,
    preparedByUserId: actor.userId, preparedAt, artifactsStagedAt: null,
    dbCommittedAt: null, completedAt: null, abortedAt: null,
    createdAt: preparedAt, updatedAt: preparedAt,
  };

  const manifest = [
    ...policyPreview.preview.reportArtifactReferences.map((storageReference) => ({
      id: crypto.randomUUID(), tenantId, executionId: row.id, kind: 'REPORT' as const,
      storageReference, createdAt: preparedAt, updatedAt: preparedAt,
    })),
    ...policyPreview.preview.activeTenantExportPackageReferences.map((storageReference) => ({
      id: crypto.randomUUID(), tenantId, executionId: row.id, kind: 'TENANT_EXPORT' as const,
      storageReference, createdAt: preparedAt, updatedAt: preparedAt,
    })),
    ...policyPreview.preview.dataSubjectDeliveryPackageReferences.map((storageReference) => ({
      id: crypto.randomUUID(), tenantId, executionId: row.id, kind: 'DATA_SUBJECT_EXPORT' as const,
      storageReference, createdAt: preparedAt, updatedAt: preparedAt,
    })),
  ].sort((left, right) => left.kind.localeCompare(right.kind)
    || left.storageReference.localeCompare(right.storageReference));

  await db.transaction(async (tx) => {
    await tx.insert(athleteAnonymizationExecutions).values(row);
    if (manifest.length > 0) await tx.insert(athleteAnonymizationExecutionArtifacts).values(manifest);
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.anonymization_execution_prepared',
      entityType: 'athlete_anonymization_execution',
      entityId: row.id,
      source: 'SYSTEM',
      after: {
        executionVersion: row.executionVersion,
        approvalId,
        athleteId,
        status: row.status,
        reportArtifactCount: policyPreview.preview.reportArtifactReferences.length,
        tenantExportArtifactCount: policyPreview.preview.activeTenantExportPackageReferences.length,
        dataSubjectExportArtifactCount: policyPreview.preview.dataSubjectDeliveryPackageReferences.length,
      },
      occurredAt: preparedAt,
    });
  });

  return stored(row);
}
