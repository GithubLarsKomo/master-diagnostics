import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athletes,
  auditEventPrivacyRedactions,
  auditEvents,
} from '../schema';
import {
  appendAuditEvent,
  auditActorFields,
  type AuditActorContext,
} from './audit';
import { getAthleteIrreversibleProcessingPrecheck } from './irreversible-processing';

export const AUDIT_PRIVACY_REDACTION_VERSION = 1 as const;
export const AUDIT_PRIVACY_REDACTED_JSON = '{"auditSchemaVersion":3,"privacyRedacted":true}';
export const AUDIT_PRIVACY_REDACTED_TEXT = '[REDACTED]';

export type AuditPrivacyRedactionActor = AuditActorContext;

export interface RedactHistoricalAuditEventInput {
  auditEventId: string;
  maintenanceReference: string;
  assessedAt?: string;
}

function requireMaintenanceReference(value: string): string {
  const reference = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{4,119}$/.test(reference)) {
    throw new Error('Privacy maintenance reference must be a 5-120 character technical reference');
  }
  return reference;
}

function payloadReferences(value: string | null, identifier: string): boolean {
  return value?.includes(identifier) ?? false;
}

function eventReferencesAthlete(
  event: typeof auditEvents.$inferSelect,
  athleteId: string,
  linkedUserId: string | null,
): boolean {
  if (event.entityType === 'athlete' && event.entityId === athleteId) return true;
  if (
    payloadReferences(event.beforeJson, athleteId)
    || payloadReferences(event.afterJson, athleteId)
  ) return true;
  if (!linkedUserId) return false;
  return (
    event.actorUserId === linkedUserId
    || payloadReferences(event.beforeJson, linkedUserId)
    || payloadReferences(event.afterJson, linkedUserId)
  );
}

/**
 * Applies the one-way SPEC §33.3 privacy transformation to one historical
 * athlete-related audit event. The database trigger defines the only allowed
 * replacement values; this service cannot supply arbitrary audit edits.
 *
 * This is audit maintenance only. It does not anonymize athlete fachdata and is
 * intentionally not exposed through a web route.
 */
export async function redactHistoricalAuditEventForAthlete(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: AuditPrivacyRedactionActor,
  input: RedactHistoricalAuditEventInput,
) {
  if (actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only tenant admins may perform audit privacy maintenance');
  }
  const maintenanceReference = requireMaintenanceReference(input.maintenanceReference);
  const assessedAt = input.assessedAt ?? new Date().toISOString();
  const precheck = await getAthleteIrreversibleProcessingPrecheck(
    db,
    tenantId,
    athleteId,
    assessedAt,
  );
  if (!precheck.passesPrecheck) {
    throw new Error(`Athlete is not ready for irreversible processing: ${precheck.blockers.join(', ')}`);
  }

  const [athlete] = await db
    .select({ linkedUserId: athletes.linkedUserId })
    .from(athletes)
    .where(and(
      eq(athletes.id, athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .limit(1);
  if (!athlete) throw new Error('Athlete not found');

  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.id, input.auditEventId),
        eq(auditEvents.tenantId, tenantId),
      ))
      .limit(1);
    if (!event) throw new Error('Audit event not found');
    if (!eventReferencesAthlete(event, athleteId, athlete.linkedUserId)) {
      throw new Error('Audit event is not linked to the athlete');
    }

    const [existing] = await tx
      .select({ id: auditEventPrivacyRedactions.id })
      .from(auditEventPrivacyRedactions)
      .where(eq(auditEventPrivacyRedactions.auditEventId, event.id))
      .limit(1);
    if (existing) throw new Error('Audit event has already been privacy redacted');

    const redactActorUserId = athlete.linkedUserId !== null
      && event.actorUserId === athlete.linkedUserId;
    const redactSessionId = redactActorUserId && event.sessionId !== null;
    const redactReason = event.reason !== null;
    const redactBeforeJson = event.beforeJson !== null;
    const redactAfterJson = event.afterJson !== null;
    if (
      !redactActorUserId
      && !redactSessionId
      && !redactReason
      && !redactBeforeJson
      && !redactAfterJson
    ) {
      throw new Error('Audit event contains no redactable privacy detail');
    }

    const now = new Date().toISOString();
    const redaction = {
      id: crypto.randomUUID(),
      tenantId,
      auditEventId: event.id,
      subjectAthleteId: athleteId,
      redactionVersion: AUDIT_PRIVACY_REDACTION_VERSION,
      redactActorUserId,
      redactSessionId,
      redactReason,
      redactBeforeJson,
      redactAfterJson,
      requestedByUserId: actor.userId,
      maintenanceReference,
      redactedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(auditEventPrivacyRedactions).values(redaction);

    const [updatedEvent] = await tx
      .update(auditEvents)
      .set({
        actorUserId: redactActorUserId ? null : event.actorUserId,
        sessionId: redactSessionId ? null : event.sessionId,
        reason: redactReason ? AUDIT_PRIVACY_REDACTED_TEXT : event.reason,
        beforeJson: redactBeforeJson ? AUDIT_PRIVACY_REDACTED_JSON : event.beforeJson,
        afterJson: redactAfterJson ? AUDIT_PRIVACY_REDACTED_JSON : event.afterJson,
      })
      .where(and(
        eq(auditEvents.id, event.id),
        eq(auditEvents.tenantId, tenantId),
      ))
      .returning();
    if (!updatedEvent) throw new Error('Audit event privacy redaction was not applied');

    const redactedFields = [
      redactActorUserId ? 'actorUserId' : null,
      redactSessionId ? 'sessionId' : null,
      redactReason ? 'reason' : null,
      redactBeforeJson ? 'beforeJson' : null,
      redactAfterJson ? 'afterJson' : null,
    ].filter((field): field is string => field !== null);

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'audit.privacy_redacted',
      entityType: 'audit_event',
      entityId: event.id,
      source: 'SYSTEM',
      after: {
        auditPrivacyRedactionId: redaction.id,
        subjectAthleteId: athleteId,
        redactionVersion: AUDIT_PRIVACY_REDACTION_VERSION,
        maintenanceReference,
        redactedFields,
      },
    });

    return Object.freeze({
      redaction: Object.freeze({ ...redaction }),
      event: Object.freeze({ ...updatedEvent }),
      redactedFields: Object.freeze(redactedFields),
    });
  });
}
