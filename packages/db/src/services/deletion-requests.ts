import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteDeletionRequests,
  athleteGuardians,
  athleteSnapshots,
  athletes,
  coachAthleteAssignments,
  consents,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export type DeletionActor = AuditActorContext;

function deletionRequestAuditState(
  request: typeof athleteDeletionRequests.$inferSelect | typeof athleteDeletionRequests.$inferInsert,
) {
  return {
    id: request.id,
    athleteId: request.athleteId,
    status: request.status,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt ?? null,
    completedAt: request.completedAt ?? null,
  };
}

function athleteDeletionAuditState(athlete: typeof athletes.$inferSelect) {
  return {
    athleteId: athlete.id,
    usageBlockedAt: athlete.consentBlockedAt,
    deletedAt: athlete.deletedAt,
    linkedToUser: athlete.linkedUserId !== null,
  };
}

async function requireAthlete(db: Database, tenantId: string, athleteId: string) {
  const [athlete] = await db.select().from(athletes).where(and(
    eq(athletes.id, athleteId),
    eq(athletes.tenantId, tenantId),
    isNull(athletes.deletedAt),
  )).limit(1);
  if (!athlete) throw new Error('Athlete not found');
  return athlete;
}

export async function previewAthleteDeletion(db: Database, tenantId: string, athleteId: string) {
  const athlete = await requireAthlete(db, tenantId, athleteId);
  const [snapshots, assignments, consentRows, guardians, requests] = await Promise.all([
    db.select({ id: athleteSnapshots.id }).from(athleteSnapshots).where(and(eq(athleteSnapshots.tenantId, tenantId), eq(athleteSnapshots.athleteId, athleteId))),
    db.select({ id: coachAthleteAssignments.id }).from(coachAthleteAssignments).where(and(eq(coachAthleteAssignments.tenantId, tenantId), eq(coachAthleteAssignments.athleteId, athleteId))),
    db.select({ id: consents.id }).from(consents).where(and(eq(consents.tenantId, tenantId), eq(consents.athleteId, athleteId))),
    db.select({ id: athleteGuardians.id }).from(athleteGuardians).where(and(eq(athleteGuardians.tenantId, tenantId), eq(athleteGuardians.athleteId, athleteId))),
    db.select({ id: athleteDeletionRequests.id }).from(athleteDeletionRequests).where(and(eq(athleteDeletionRequests.tenantId, tenantId), eq(athleteDeletionRequests.athleteId, athleteId))),
  ]);
  return {
    athlete: { id: athlete.id, firstName: athlete.firstName, lastName: athlete.lastName },
    relatedRecords: {
      snapshots: snapshots.length,
      coachAssignments: assignments.length,
      consents: consentRows.length,
      guardians: guardians.length,
      deletionRequests: requests.length,
    },
    strategy: 'SOFT_DELETE_AND_RETAIN_AUDIT' as const,
  };
}

export async function listDeletionRequests(db: Database, tenantId: string, athleteId: string) {
  await requireAthlete(db, tenantId, athleteId);
  return db.select().from(athleteDeletionRequests).where(and(
    eq(athleteDeletionRequests.tenantId, tenantId),
    eq(athleteDeletionRequests.athleteId, athleteId),
  )).orderBy(desc(athleteDeletionRequests.requestedAt));
}

export async function requestAthleteDeletion(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: DeletionActor,
  reason: string,
) {
  await requireAthlete(db, tenantId, athleteId);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3) throw new Error('Deletion reason is required');
  const [openRequest] = await db.select({ id: athleteDeletionRequests.id }).from(athleteDeletionRequests).where(and(
    eq(athleteDeletionRequests.tenantId, tenantId),
    eq(athleteDeletionRequests.athleteId, athleteId),
    eq(athleteDeletionRequests.status, 'REQUESTED'),
  )).limit(1);
  if (openRequest) throw new Error('Open deletion request already exists');

  const now = new Date().toISOString();
  const request = {
    id: crypto.randomUUID(), tenantId, athleteId, status: 'REQUESTED' as const,
    reason: normalizedReason, requestedAt: now, decidedAt: null, decisionReason: null,
    completedAt: null, createdAt: now, updatedAt: now,
  };
  await db.transaction(async (tx) => {
    await tx.insert(athleteDeletionRequests).values(request);
    await tx.update(athletes).set({ consentBlockedAt: now, updatedAt: now }).where(and(eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId)));
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.deletion_requested',
      entityType: 'athlete_deletion_request',
      entityId: request.id,
      source: 'WEB',
      after: deletionRequestAuditState(request),
      occurredAt: now,
    });
  });
  return request;
}

export async function decideAthleteDeletion(
  db: Database,
  tenantId: string,
  athleteId: string,
  requestId: string,
  actor: DeletionActor,
  decision: 'APPROVED' | 'REJECTED',
  reason: string,
) {
  await requireAthlete(db, tenantId, athleteId);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3) throw new Error('Decision reason is required');
  const [request] = await db.select().from(athleteDeletionRequests).where(and(
    eq(athleteDeletionRequests.id, requestId), eq(athleteDeletionRequests.tenantId, tenantId),
    eq(athleteDeletionRequests.athleteId, athleteId), eq(athleteDeletionRequests.status, 'REQUESTED'),
  )).limit(1);
  if (!request) throw new Error('Open deletion request not found');
  const now = new Date().toISOString();
  const decidedRequest = {
    ...request,
    status: decision,
    decidedAt: now,
    decisionReason: normalizedReason,
  };
  await db.transaction(async (tx) => {
    await tx.update(athleteDeletionRequests).set({ status: decision, decidedAt: now, decisionReason: normalizedReason, updatedAt: now })
      .where(eq(athleteDeletionRequests.id, requestId));
    if (decision === 'REJECTED') {
      await tx.update(athletes).set({ consentBlockedAt: null, updatedAt: now }).where(and(eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId)));
    }
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: decision === 'APPROVED' ? 'athlete.deletion_approved' : 'athlete.deletion_rejected',
      entityType: 'athlete_deletion_request',
      entityId: requestId,
      source: 'WEB',
      before: deletionRequestAuditState(request),
      after: deletionRequestAuditState(decidedRequest),
      occurredAt: now,
    });
  });
}

export async function completeAthleteDeletion(
  db: Database,
  tenantId: string,
  athleteId: string,
  requestId: string,
  actor: DeletionActor,
  reason: string,
) {
  const athlete = await requireAthlete(db, tenantId, athleteId);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3) throw new Error('Completion reason is required');
  const [request] = await db.select().from(athleteDeletionRequests).where(and(
    eq(athleteDeletionRequests.id, requestId), eq(athleteDeletionRequests.tenantId, tenantId),
    eq(athleteDeletionRequests.athleteId, athleteId), eq(athleteDeletionRequests.status, 'APPROVED'),
  )).limit(1);
  if (!request) throw new Error('Approved deletion request not found');
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(athleteDeletionRequests).set({ status: 'COMPLETED', completedAt: now, updatedAt: now }).where(eq(athleteDeletionRequests.id, requestId));
    await tx.update(athletes).set({ deletedAt: now, consentBlockedAt: now, updatedAt: now }).where(and(eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId)));
    await tx.update(coachAthleteAssignments).set({ validUntil: now, updatedAt: now }).where(and(eq(coachAthleteAssignments.tenantId, tenantId), eq(coachAthleteAssignments.athleteId, athleteId), isNull(coachAthleteAssignments.validUntil)));
    await tx.update(athleteGuardians).set({ revokedAt: now, updatedAt: now }).where(and(eq(athleteGuardians.tenantId, tenantId), eq(athleteGuardians.athleteId, athleteId), isNull(athleteGuardians.revokedAt)));
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.deletion_completed',
      entityType: 'athlete',
      entityId: athleteId,
      source: 'WEB',
      reason: normalizedReason,
      before: athleteDeletionAuditState(athlete),
      after: {
        athleteId,
        usageBlockedAt: now,
        deletedAt: now,
        linkedToUser: athlete.linkedUserId !== null,
        retainedAudit: true,
      },
      occurredAt: now,
    });
  });
}
