import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes, consents } from '../schema';
import { appendAuditEvent } from './audit';

export interface ConsentActor {
  userId: string;
  role: string;
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

export async function listConsents(db: Database, tenantId: string, athleteId: string) {
  await requireAthlete(db, tenantId, athleteId);
  return db.select().from(consents).where(and(
    eq(consents.tenantId, tenantId),
    eq(consents.athleteId, athleteId),
  )).orderBy(desc(consents.createdAt));
}

export async function grantConsent(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: ConsentActor,
  consentType: string,
  documentVersion: string,
) {
  await requireAthlete(db, tenantId, athleteId);
  const type = consentType.trim();
  const version = documentVersion.trim();
  if (!type || !version) throw new Error('Consent type and document version are required');

  const now = new Date().toISOString();
  const consentId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(consents).values({
      id: consentId, tenantId, athleteId, consentType: type,
      status: 'GRANTED', grantedAt: now, withdrawnAt: null,
      documentVersion: version, createdAt: now, updatedAt: now,
    });
    await tx.update(athletes).set({ consentBlockedAt: null, updatedAt: now }).where(and(
      eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId),
    ));
    await appendAuditEvent(tx, {
      tenantId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'consent.granted',
      entityType: 'consent',
      entityId: consentId,
      source: 'WEB',
      after: { athleteId, consentType: type, documentVersion: version },
      occurredAt: now,
    });
  });
  return consentId;
}

export async function withdrawConsent(
  db: Database,
  tenantId: string,
  athleteId: string,
  consentId: string,
  actor: ConsentActor,
  reason: string,
) {
  await requireAthlete(db, tenantId, athleteId);
  const withdrawalReason = reason.trim();
  if (!withdrawalReason) throw new Error('Withdrawal reason is required');

  const [consent] = await db.select().from(consents).where(and(
    eq(consents.id, consentId), eq(consents.tenantId, tenantId), eq(consents.athleteId, athleteId),
  )).limit(1);
  if (!consent) throw new Error('Consent not found');
  if (consent.status !== 'GRANTED') throw new Error('Only granted consent can be withdrawn');

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(consents).set({ status: 'WITHDRAWN', withdrawnAt: now, updatedAt: now }).where(and(
      eq(consents.id, consentId), eq(consents.tenantId, tenantId), eq(consents.athleteId, athleteId),
    ));
    await tx.update(athletes).set({ consentBlockedAt: now, updatedAt: now }).where(and(
      eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId),
    ));
    await appendAuditEvent(tx, {
      tenantId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'consent.withdrawn',
      entityType: 'consent',
      entityId: consentId,
      source: 'WEB',
      reason: withdrawalReason,
      before: consent,
      after: { ...consent, status: 'WITHDRAWN', withdrawnAt: now },
      occurredAt: now,
    });
  });
}
