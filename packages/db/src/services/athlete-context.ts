import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteSnapshots,
  athletes,
  auditEvents,
  coachAthleteAssignments,
  tenantMemberships,
  users,
} from '../schema';

export interface AthleteContextActor {
  userId: string;
  role: string;
}

export async function listActiveTrainers(db: Database, tenantId: string) {
  return db
    .select({ userId: users.id, displayName: users.displayName, email: users.email })
    .from(tenantMemberships)
    .innerJoin(users, eq(users.id, tenantMemberships.userId))
    .where(and(
      eq(tenantMemberships.tenantId, tenantId),
      eq(tenantMemberships.role, 'TRAINER'),
      eq(tenantMemberships.active, true),
      isNull(users.disabledAt),
    ));
}

export async function assignCoach(
  db: Database,
  tenantId: string,
  athleteId: string,
  coachUserId: string,
  isPrimary: boolean,
  actor: AthleteContextActor,
) {
  const [athlete] = await db.select({ id: athletes.id }).from(athletes).where(and(
    eq(athletes.id, athleteId),
    eq(athletes.tenantId, tenantId),
    isNull(athletes.deletedAt),
  )).limit(1);
  if (!athlete) throw new Error('Athlete not found');

  const [membership] = await db.select({ userId: tenantMemberships.userId }).from(tenantMemberships).where(and(
    eq(tenantMemberships.tenantId, tenantId),
    eq(tenantMemberships.userId, coachUserId),
    eq(tenantMemberships.role, 'TRAINER'),
    eq(tenantMemberships.active, true),
  )).limit(1);
  if (!membership) throw new Error('Active trainer membership not found');

  const now = new Date().toISOString();
  const assignmentId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    if (isPrimary) {
      await tx.update(coachAthleteAssignments).set({ isPrimary: false, updatedAt: now }).where(and(
        eq(coachAthleteAssignments.tenantId, tenantId),
        eq(coachAthleteAssignments.athleteId, athleteId),
        isNull(coachAthleteAssignments.validUntil),
      ));
    }
    await tx.insert(coachAthleteAssignments).values({
      id: assignmentId, tenantId, athleteId, coachUserId, isPrimary,
      validFrom: now, validUntil: null, createdAt: now, updatedAt: now,
    });
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(), tenantId, occurredAt: now,
      actorUserId: actor.userId, actorRole: actor.role,
      action: 'athlete.coach_assigned', entityType: 'coach_athlete_assignment', entityId: assignmentId,
      source: 'WEB', correlationId: crypto.randomUUID(),
      afterJson: JSON.stringify({ athleteId, coachUserId, isPrimary }),
      createdAt: now, updatedAt: now,
    });
  });
  return assignmentId;
}

export async function listCoachAssignments(db: Database, tenantId: string, athleteId: string) {
  return db
    .select({
      id: coachAthleteAssignments.id,
      coachUserId: coachAthleteAssignments.coachUserId,
      isPrimary: coachAthleteAssignments.isPrimary,
      validFrom: coachAthleteAssignments.validFrom,
      displayName: users.displayName,
      email: users.email,
    })
    .from(coachAthleteAssignments)
    .innerJoin(users, eq(users.id, coachAthleteAssignments.coachUserId))
    .where(and(
      eq(coachAthleteAssignments.tenantId, tenantId),
      eq(coachAthleteAssignments.athleteId, athleteId),
      isNull(coachAthleteAssignments.validUntil),
    ));
}

export async function createAthleteSnapshot(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: AthleteContextActor,
) {
  const [athlete] = await db.select().from(athletes).where(and(
    eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId), isNull(athletes.deletedAt),
  )).limit(1);
  if (!athlete) throw new Error('Athlete not found');

  const [latest] = await db.select({ version: athleteSnapshots.version }).from(athleteSnapshots).where(and(
    eq(athleteSnapshots.tenantId, tenantId), eq(athleteSnapshots.athleteId, athleteId),
  )).orderBy(desc(athleteSnapshots.version)).limit(1);

  const now = new Date().toISOString();
  const snapshot = {
    id: crypto.randomUUID(), tenantId, athleteId,
    snapshotJson: JSON.stringify(athlete), version: (latest?.version ?? 0) + 1,
    createdAt: now, updatedAt: now,
  };
  await db.transaction(async (tx) => {
    await tx.insert(athleteSnapshots).values(snapshot);
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(), tenantId, occurredAt: now,
      actorUserId: actor.userId, actorRole: actor.role,
      action: 'athlete.snapshot_created', entityType: 'athlete_snapshot', entityId: snapshot.id,
      source: 'WEB', correlationId: crypto.randomUUID(),
      afterJson: JSON.stringify({ athleteId, version: snapshot.version }),
      createdAt: now, updatedAt: now,
    });
  });
  return snapshot;
}

export async function listAthleteSnapshots(db: Database, tenantId: string, athleteId: string) {
  return db.select().from(athleteSnapshots).where(and(
    eq(athleteSnapshots.tenantId, tenantId), eq(athleteSnapshots.athleteId, athleteId),
  )).orderBy(desc(athleteSnapshots.version));
}
