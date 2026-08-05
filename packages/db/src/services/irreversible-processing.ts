import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteDeletionRequests, athletes } from '../schema';
import { getAthleteRetentionAssessment } from './retention';

export type IrreversibleProcessingBlocker =
  | 'RETENTION_ACTIVE'
  | 'RETENTION_MANUAL_REVIEW'
  | 'USAGE_NOT_BLOCKED'
  | 'SOFT_DELETE_NOT_COMPLETED'
  | 'DELETION_WORKFLOW_NOT_COMPLETED';

export interface AthleteIrreversibleProcessingPrecheck {
  mode: 'READ_ONLY';
  tenantId: string;
  athleteId: string;
  assessedAt: string;
  passesPrecheck: boolean;
  blockers: ReadonlyArray<IrreversibleProcessingBlocker>;
  retention: Awaited<ReturnType<typeof getAthleteRetentionAssessment>>;
  state: {
    consentBlockedAt: string | null;
    deletedAt: string | null;
    completedDeletionRequestId: string | null;
    completedDeletionRequestAt: string | null;
  };
}

function isEffectiveAt(timestamp: string | null, assessedAt: string): boolean {
  return timestamp !== null && timestamp <= assessedAt;
}

/**
 * Evaluates row-level prerequisites for a later irreversible anonymization or
 * deletion writer. This function is deliberately read-only and only represents
 * a necessary precheck. A future writer must additionally require an approved
 * pseudonymization/audit policy and explicit execution authorization.
 */
export async function getAthleteIrreversibleProcessingPrecheck(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<AthleteIrreversibleProcessingPrecheck>> {
  if (!Number.isFinite(Date.parse(assessedAt))) {
    throw new Error('Assessment time must be a valid ISO-8601 timestamp');
  }

  const [athlete] = await db
    .select({
      id: athletes.id,
      consentBlockedAt: athletes.consentBlockedAt,
      deletedAt: athletes.deletedAt,
    })
    .from(athletes)
    .where(and(
      eq(athletes.id, athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .limit(1);
  if (!athlete) throw new Error('Athlete not found');

  const retention = await getAthleteRetentionAssessment(
    db,
    tenantId,
    athleteId,
    assessedAt,
  );

  const [completedRequest] = await db
    .select({
      id: athleteDeletionRequests.id,
      completedAt: athleteDeletionRequests.completedAt,
    })
    .from(athleteDeletionRequests)
    .where(and(
      eq(athleteDeletionRequests.tenantId, tenantId),
      eq(athleteDeletionRequests.athleteId, athleteId),
      eq(athleteDeletionRequests.status, 'COMPLETED'),
      isNotNull(athleteDeletionRequests.completedAt),
      lte(athleteDeletionRequests.completedAt, assessedAt),
    ))
    .orderBy(desc(athleteDeletionRequests.completedAt))
    .limit(1);

  const blockers: IrreversibleProcessingBlocker[] = [];
  if (!retention.eligibleForIrreversibleAction) {
    blockers.push(
      retention.reason === 'MANUAL_REVIEW_REQUIRED'
        ? 'RETENTION_MANUAL_REVIEW'
        : 'RETENTION_ACTIVE',
    );
  }
  if (!isEffectiveAt(athlete.consentBlockedAt, assessedAt)) {
    blockers.push('USAGE_NOT_BLOCKED');
  }
  if (!isEffectiveAt(athlete.deletedAt, assessedAt)) {
    blockers.push('SOFT_DELETE_NOT_COMPLETED');
  }
  if (!completedRequest) {
    blockers.push('DELETION_WORKFLOW_NOT_COMPLETED');
  }

  return Object.freeze({
    mode: 'READ_ONLY' as const,
    tenantId,
    athleteId,
    assessedAt,
    passesPrecheck: blockers.length === 0,
    blockers: Object.freeze([...blockers]),
    retention,
    state: Object.freeze({
      consentBlockedAt: athlete.consentBlockedAt,
      deletedAt: athlete.deletedAt,
      completedDeletionRequestId: completedRequest?.id ?? null,
      completedDeletionRequestAt: completedRequest?.completedAt ?? null,
    }),
  });
}
