import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteAnonymizationExecutions } from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import { validateAthleteAnonymizationApproval } from './anonymization-approval';
import type { GlobalPrivacyCapabilities } from './global-privacy-policy';

export const ANONYMIZATION_EXECUTION_VERSION = 1 as const;

export type AthleteAnonymizationExecutionStatus =
  | 'PREPARING'
  | 'ARTIFACTS_STAGED'
  | 'DB_COMMITTED'
  | 'COMPLETED'
  | 'ABORTED';

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

/**
 * Creates the durable preparation record for one approved irreversible run.
 * This is deliberately still non-destructive. A later writer must revalidate
 * the approval immediately before staging the first external artifact.
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
    db,
    tenantId,
    athleteId,
    approvalId,
    globalCapabilities,
    preparedAt,
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

  const row = {
    id: crypto.randomUUID(),
    tenantId,
    athleteId,
    approvalId,
    executionVersion: ANONYMIZATION_EXECUTION_VERSION,
    status: 'PREPARING' as const,
    preparedByUserId: actor.userId,
    preparedAt,
    artifactsStagedAt: null,
    dbCommittedAt: null,
    completedAt: null,
    abortedAt: null,
    createdAt: preparedAt,
    updatedAt: preparedAt,
  };

  await db.transaction(async (tx) => {
    await tx.insert(athleteAnonymizationExecutions).values(row);
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
      },
      occurredAt: preparedAt,
    });
  });

  return stored(row);
}
