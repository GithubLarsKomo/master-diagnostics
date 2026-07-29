import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteGuardians, athletes, auditEvents } from '../schema';

export interface GuardianInput {
  fullName: string;
  relationship: string;
  email?: string;
  phone?: string;
  validUntil?: string;
}

export interface GuardianActor {
  userId: string;
  role: string;
}

function normalize(input: GuardianInput): GuardianInput {
  const fullName = input.fullName.trim();
  const relationship = input.relationship.trim();
  const email = input.email?.trim();
  const phone = input.phone?.trim();
  const validUntil = input.validUntil?.trim();

  if (!fullName || !relationship) throw new Error('Guardian name and relationship are required');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Guardian email is invalid');
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new Error('Guardian validity must use YYYY-MM-DD');

  return {
    fullName,
    relationship,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(validUntil ? { validUntil } : {}),
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

export async function listGuardians(db: Database, tenantId: string, athleteId: string) {
  await requireAthlete(db, tenantId, athleteId);
  return db.select().from(athleteGuardians).where(and(
    eq(athleteGuardians.tenantId, tenantId),
    eq(athleteGuardians.athleteId, athleteId),
  )).orderBy(desc(athleteGuardians.authorityConfirmedAt));
}

export async function registerGuardian(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: GuardianActor,
  input: GuardianInput,
) {
  await requireAthlete(db, tenantId, athleteId);
  const value = normalize(input);
  const now = new Date().toISOString();
  const guardian = {
    id: crypto.randomUUID(),
    tenantId,
    athleteId,
    fullName: value.fullName,
    relationship: value.relationship,
    email: value.email ?? null,
    phone: value.phone ?? null,
    authorityConfirmedAt: now,
    validUntil: value.validUntil ?? null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction(async (tx) => {
    await tx.insert(athleteGuardians).values(guardian);
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(), tenantId, occurredAt: now,
      actorUserId: actor.userId, actorRole: actor.role,
      action: 'guardian.registered', entityType: 'athlete_guardian', entityId: guardian.id,
      source: 'WEB', correlationId: crypto.randomUUID(), afterJson: JSON.stringify(guardian),
      createdAt: now, updatedAt: now,
    });
  });
  return guardian;
}

export async function revokeGuardian(
  db: Database,
  tenantId: string,
  athleteId: string,
  guardianId: string,
  actor: GuardianActor,
  reason: string,
) {
  await requireAthlete(db, tenantId, athleteId);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3) throw new Error('Guardian revocation reason is required');
  const [guardian] = await db.select().from(athleteGuardians).where(and(
    eq(athleteGuardians.id, guardianId),
    eq(athleteGuardians.tenantId, tenantId),
    eq(athleteGuardians.athleteId, athleteId),
    isNull(athleteGuardians.revokedAt),
  )).limit(1);
  if (!guardian) throw new Error('Active guardian not found');
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(athleteGuardians).set({ revokedAt: now, updatedAt: now }).where(eq(athleteGuardians.id, guardianId));
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(), tenantId, occurredAt: now,
      actorUserId: actor.userId, actorRole: actor.role,
      action: 'guardian.revoked', entityType: 'athlete_guardian', entityId: guardianId,
      source: 'WEB', reason: normalizedReason, correlationId: crypto.randomUUID(), beforeJson: JSON.stringify(guardian),
      createdAt: now, updatedAt: now,
    });
  });
}

export function athleteIsMinor(birthDate: string, now = new Date()) {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birth.getUTCMonth()
    || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age < 18;
}

export async function assertGuardianRequirement(db: Database, tenantId: string, athleteId: string, now = new Date()) {
  const athlete = await requireAthlete(db, tenantId, athleteId);
  if (!athleteIsMinor(athlete.birthDate, now)) return;
  const guardians = await listGuardians(db, tenantId, athleteId);
  const today = now.toISOString().slice(0, 10);
  const active = guardians.some((guardian) => !guardian.revokedAt && (!guardian.validUntil || guardian.validUntil >= today));
  if (!active) throw new Error('Active guardian required for minor athlete');
}
