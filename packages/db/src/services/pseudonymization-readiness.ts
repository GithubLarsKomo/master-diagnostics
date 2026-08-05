import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteDeletionRequests, athletes, auditEvents } from '../schema';
import { getAthleteRetentionAssessment } from './retention';

export type PseudonymizationReadinessBlocker =
  | 'RETENTION_ACTIVE'
  | 'RETENTION_MANUAL_REVIEW'
  | 'DELETION_WORKFLOW_NOT_COMPLETED'
  | 'ATHLETE_NOT_SOFT_DELETED'
  | 'ATHLETE_NOT_USAGE_BLOCKED';

export interface AthletePseudonymizationReadiness {
  mode: 'READ_ONLY';
  athleteId: string;
  assessedAt: string;
  eligibleForExplicitApproval: boolean;
  blockers: ReadonlyArray<PseudonymizationReadinessBlocker>;
  deletionRequestId: string | null;
  deletionCompletedAt: string | null;
  auditEventIdsRequiringPseudonymization: ReadonlyArray<string>;
  auditDirectIdentifierCount: number;
  requiresAuditPseudonymization: boolean;
}

const directIdentifierKeys = new Set([
  'firstName',
  'lastName',
  'birthDate',
  'fullName',
  'email',
  'phone',
  'displayName',
  'linkedUserId',
]);

function jsonContainsDirectIdentifier(
  json: string | null,
  linkedUserId: string | null,
): boolean {
  if (!json) return false;
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return true;
  }

  const visit = (candidate: unknown): boolean => {
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (!candidate || typeof candidate !== 'object') {
      return linkedUserId !== null && candidate === linkedUserId;
    }
    return Object.entries(candidate).some(([key, nested]) => (
      (directIdentifierKeys.has(key) && nested !== null && nested !== '')
      || visit(nested)
    ));
  };

  return visit(value);
}

function auditEventReferencesAthlete(
  event: {
    entityType: string;
    entityId: string | null;
    actorUserId: string | null;
    beforeJson: string | null;
    afterJson: string | null;
  },
  athleteId: string,
  linkedUserId: string | null,
): boolean {
  if (event.entityType === 'athlete' && event.entityId === athleteId) return true;
  if (linkedUserId && event.actorUserId === linkedUserId) return true;
  return (
    event.beforeJson?.includes(athleteId) === true
    || event.afterJson?.includes(athleteId) === true
    || (linkedUserId !== null && (
      event.beforeJson?.includes(linkedUserId) === true
      || event.afterJson?.includes(linkedUserId) === true
    ))
  );
}

function auditEventContainsDirectIdentifier(
  event: {
    actorUserId: string | null;
    sessionId: string | null;
    reason: string | null;
    beforeJson: string | null;
    afterJson: string | null;
  },
  linkedUserId: string | null,
): boolean {
  if (linkedUserId && event.actorUserId === linkedUserId) return true;
  if (linkedUserId && event.actorUserId === linkedUserId && event.sessionId) return true;
  // Reasons are free text and may contain direct identifiers; fail closed for
  // athlete-related audit rows until the controlled pseudonymization writer
  // replaces them with a privacy-safe marker.
  if (event.reason) return true;
  return (
    jsonContainsDirectIdentifier(event.beforeJson, linkedUserId)
    || jsonContainsDirectIdentifier(event.afterJson, linkedUserId)
  );
}

/**
 * Builds the read-only protection plan for a future irreversible athlete-data
 * pseudonymization writer. It does not grant approval and never mutates data.
 *
 * `eligibleForExplicitApproval` means only that retention, deletion workflow,
 * soft-delete and usage-blocking preconditions are satisfied. Audit rows listed
 * in `auditEventIdsRequiringPseudonymization` must be privacy-sanitized by the
 * future irreversible transaction in accordance with SPEC §33.3.
 */
export async function getAthletePseudonymizationReadiness(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<AthletePseudonymizationReadiness>> {
  const [athlete] = await db
    .select({
      id: athletes.id,
      linkedUserId: athletes.linkedUserId,
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
  const [completedDeletion] = await db
    .select({
      id: athleteDeletionRequests.id,
      completedAt: athleteDeletionRequests.completedAt,
    })
    .from(athleteDeletionRequests)
    .where(and(
      eq(athleteDeletionRequests.tenantId, tenantId),
      eq(athleteDeletionRequests.athleteId, athleteId),
      eq(athleteDeletionRequests.status, 'COMPLETED'),
    ))
    .orderBy(desc(athleteDeletionRequests.completedAt))
    .limit(1);

  const blockers: PseudonymizationReadinessBlocker[] = [];
  if (retention.reason === 'RETENTION_ACTIVE') blockers.push('RETENTION_ACTIVE');
  if (retention.reason === 'MANUAL_REVIEW_REQUIRED') blockers.push('RETENTION_MANUAL_REVIEW');
  if (!completedDeletion?.completedAt) blockers.push('DELETION_WORKFLOW_NOT_COMPLETED');
  if (!athlete.deletedAt) blockers.push('ATHLETE_NOT_SOFT_DELETED');
  if (!athlete.consentBlockedAt) blockers.push('ATHLETE_NOT_USAGE_BLOCKED');

  const tenantAuditEvents = await db
    .select({
      id: auditEvents.id,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      actorUserId: auditEvents.actorUserId,
      sessionId: auditEvents.sessionId,
      reason: auditEvents.reason,
      beforeJson: auditEvents.beforeJson,
      afterJson: auditEvents.afterJson,
    })
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(asc(auditEvents.id));

  const auditEventIdsRequiringPseudonymization = tenantAuditEvents
    .filter((event) => auditEventReferencesAthlete(
      event,
      athleteId,
      athlete.linkedUserId,
    ))
    .filter((event) => auditEventContainsDirectIdentifier(
      event,
      athlete.linkedUserId,
    ))
    .map((event) => event.id);

  return Object.freeze({
    mode: 'READ_ONLY' as const,
    athleteId,
    assessedAt,
    eligibleForExplicitApproval: blockers.length === 0,
    blockers: Object.freeze(blockers),
    deletionRequestId: completedDeletion?.id ?? null,
    deletionCompletedAt: completedDeletion?.completedAt ?? null,
    auditEventIdsRequiringPseudonymization: Object.freeze(
      auditEventIdsRequiringPseudonymization,
    ),
    auditDirectIdentifierCount: auditEventIdsRequiringPseudonymization.length,
    requiresAuditPseudonymization: auditEventIdsRequiringPseudonymization.length > 0,
  });
}
