import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteSnapshots,
  athletes,
  coachAthleteAssignments,
  tenantMemberships,
} from '../schema';

export async function assignCoach(
  db: Database,
  tenantId: string,
  athleteId: string,
  coachUserId: string,
  isPrimary: boolean,
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
  await db.transaction(async (tx) => {
    if (isPrimary) {
      await tx.update(coachAthleteAssignments).set({ isPrimary: false, updatedAt: now }).where(and(
        eq(coachAthleteAssignments.tenantId, tenantId),
        eq(coachAthleteAssignments.athleteId, athleteId),
        isNull(coachAthleteAssignments.validUntil),
      ));
    }
    await tx.insert(coachAthleteAssignments).values({
      id: crypto.randomUUID(), tenantId, athleteId, coachUserId, isPrimary,
      validFrom: now, validUntil: null, createdAt: now, updatedAt: now,
    });
  });
}

export async function listCoachAssignments(db: Database, tenantId: string, athleteId: string) {
  return db.select().from(coachAthleteAssignments).where(and(
    eq(coachAthleteAssignments.tenantId, tenantId),
    eq(coachAthleteAssignments.athleteId, athleteId),
    isNull(coachAthleteAssignments.validUntil),
  ));
}

export async function createAthleteSnapshot(db: Database, tenantId: string, athleteId: string) {
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
  await db.insert(athleteSnapshots).values(snapshot);
  return snapshot;
}

export async function listAthleteSnapshots(db: Database, tenantId: string, athleteId: string) {
  return db.select().from(athleteSnapshots).where(and(
    eq(athleteSnapshots.tenantId, tenantId), eq(athleteSnapshots.athleteId, athleteId),
  )).orderBy(desc(athleteSnapshots.version));
}
