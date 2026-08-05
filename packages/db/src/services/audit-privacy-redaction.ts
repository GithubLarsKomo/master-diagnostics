import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  auditEventPrivacyRedactions,
  auditEvents,
} from '../schema';
import {
  appendAuditEvent,
  auditActorFields,
  type AuditActorContext,
} from './audit';
import {
  inventoryAthleteAuditPrivacyMaintenance,
  type AuditPrivacyMaintenanceCandidate,
} from './audit-privacy-inventory';
import { getAthleteIrreversibleProcessingPrecheck } from './irreversible-processing';

export const AUDIT_PRIVACY_REDACTION_VERSION = 1 as const;
export const AUDIT_PRIVACY_REDACTED_JSON = '{"auditSchemaVersion":3,"privacyRedacted":true}';
export const AUDIT_PRIVACY_REDACTED_TEXT = '[REDACTED]';

export type AuditPrivacyRedactionActor = AuditActorContext;
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

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

/**
 * Applies exactly one already-inventoried audit privacy candidate inside an
 * existing database transaction. The caller owns precheck/inventory freshness
 * and transaction boundaries. SQLite triggers still constrain the only allowed
 * audit-event replacement values.
 */
export async function applyHistoricalAuditPrivacyRedactionInTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
  athleteId: string,
  actor: AuditPrivacyRedactionActor,
  candidate: Readonly<AuditPrivacyMaintenanceCandidate>,
  maintenanceReference: string,
  redactedAt: string,
) {
  if (actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only tenant admins may perform audit privacy maintenance');
  }
  const normalizedReference = requireMaintenanceReference(maintenanceReference);

  const [existing] = await tx
    .select({ id: auditEventPrivacyRedactions.id })
    .from(auditEventPrivacyRedactions)
    .where(and(
      eq(auditEventPrivacyRedactions.tenantId, tenantId),
      eq(auditEventPrivacyRedactions.auditEventId, candidate.auditEventId),
    ))
    .limit(1);
  if (existing) throw new Error('Audit event has already been privacy redacted');

  const locations = new Set(candidate.matches.map((match) => match.location));
  const redactActorUserId = locations.has('ACTOR_USER_ID');
  const redactSessionId = locations.has('SESSION_ID');
  const redactReason = locations.has('REASON');
  const redactBeforeJson = locations.has('BEFORE_JSON');
  const redactAfterJson = locations.has('AFTER_JSON');
  const matchedIdentifierClasses = [...new Set(
    candidate.matches.flatMap((match) => match.identifierClasses),
  )].sort();

  const [event] = await tx
    .select()
    .from(auditEvents)
    .where(and(
      eq(auditEvents.id, candidate.auditEventId),
      eq(auditEvents.tenantId, tenantId),
    ))
    .limit(1);
  if (!event) throw new Error('Audit event not found');

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
    maintenanceReference: normalizedReference,
    redactedAt,
    createdAt: redactedAt,
    updatedAt: redactedAt,
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
    occurredAt: redactedAt,
    ...auditActorFields(actor),
    action: 'audit.privacy_redacted',
    entityType: 'audit_event',
    entityId: event.id,
    source: 'SYSTEM',
    after: {
      auditPrivacyRedactionId: redaction.id,
      subjectAthleteId: athleteId,
      redactionVersion: AUDIT_PRIVACY_REDACTION_VERSION,
      maintenanceReference: normalizedReference,
      redactedFields,
      matchedIdentifierClasses,
    },
  });

  return Object.freeze({
    redaction: Object.freeze({ ...redaction }),
    event: Object.freeze({ ...updatedEvent }),
    redactedFields: Object.freeze(redactedFields),
    matchedIdentifierClasses: Object.freeze(matchedIdentifierClasses),
  });
}

/**
 * Applies the one-way SPEC §33.3 privacy transformation to one historical
 * athlete-related audit event previously identified by the read-only privacy
 * inventory. This standalone service keeps its existing precheck, duplicate
 * detection and inventory semantics; the irreversible athlete writer reuses the
 * transaction-safe helper above so audit maintenance and fachdata mutation
 * commit together.
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

  // Preserve the public standalone-service contract even after a completed
  // redaction disappears from the candidate inventory.
  const [existing] = await db
    .select({ id: auditEventPrivacyRedactions.id })
    .from(auditEventPrivacyRedactions)
    .where(and(
      eq(auditEventPrivacyRedactions.tenantId, tenantId),
      eq(auditEventPrivacyRedactions.auditEventId, input.auditEventId),
    ))
    .limit(1);
  if (existing) throw new Error('Audit event has already been privacy redacted');

  const inventory = await inventoryAthleteAuditPrivacyMaintenance(
    db,
    tenantId,
    athleteId,
  );
  const candidate = inventory.candidates.find(
    (entry) => entry.auditEventId === input.auditEventId,
  );
  if (!candidate) {
    throw new Error('Audit event is not listed by the athlete privacy inventory');
  }

  return db.transaction((tx) => applyHistoricalAuditPrivacyRedactionInTransaction(
    tx,
    tenantId,
    athleteId,
    actor,
    candidate,
    maintenanceReference,
    new Date().toISOString(),
  ));
}
