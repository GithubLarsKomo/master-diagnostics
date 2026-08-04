import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes } from '../schema';
import { appendAuditEvent } from './audit';

export interface AthleteInput {
  firstName: string;
  lastName: string;
  birthDate: string;
  referenceCategory: string;
  heightCm: number;
  currentWeightKgX100: number;
  primarySport: string;
  primaryDiscipline: string;
  trainingStatus: string;
}

export interface AthleteActor {
  userId: string;
  role: string;
  authProvider?: 'BETTER_AUTH' | 'CLERK';
  sessionId?: string;
}

function normalizeInput(input: AthleteInput): AthleteInput {
  const normalized = {
    ...input,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    referenceCategory: input.referenceCategory.trim(),
    primarySport: input.primarySport.trim(),
    primaryDiscipline: input.primaryDiscipline.trim(),
    trainingStatus: input.trainingStatus.trim(),
  };

  if (!normalized.firstName || !normalized.lastName) {
    throw new Error('Athlete name is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.birthDate)) {
    throw new Error('Birth date must use YYYY-MM-DD');
  }
  if (normalized.heightCm < 80 || normalized.heightCm > 250) {
    throw new Error('Height must be between 80 and 250 cm');
  }
  if (normalized.currentWeightKgX100 < 2_000 || normalized.currentWeightKgX100 > 30_000) {
    throw new Error('Weight must be between 20 and 300 kg');
  }
  if (!normalized.referenceCategory || !normalized.primarySport || !normalized.primaryDiscipline || !normalized.trainingStatus) {
    throw new Error('Athlete classification fields are required');
  }

  return normalized;
}

export async function listAthletes(db: Database, tenantId: string) {
  return db
    .select()
    .from(athletes)
    .where(and(eq(athletes.tenantId, tenantId), isNull(athletes.deletedAt)))
    .orderBy(asc(athletes.lastName), asc(athletes.firstName));
}

export async function getAthlete(db: Database, tenantId: string, athleteId: string) {
  const rows = await db
    .select()
    .from(athletes)
    .where(and(eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId), isNull(athletes.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAthlete(
  db: Database,
  tenantId: string,
  actor: AthleteActor,
  input: AthleteInput,
) {
  const values = normalizeInput(input);
  const now = new Date().toISOString();
  const athleteId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(athletes).values({
      id: athleteId,
      tenantId,
      linkedUserId: null,
      ...values,
      consentBlockedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'athlete.created',
      entityType: 'athlete',
      entityId: athleteId,
      source: 'WEB',
      correlationId,
      authProvider: actor.authProvider ?? null,
      sessionId: actor.sessionId ?? null,
      after: values,
    });
  });

  return getAthlete(db, tenantId, athleteId);
}

export async function updateAthlete(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: AthleteActor,
  input: AthleteInput,
) {
  const before = await getAthlete(db, tenantId, athleteId);
  if (!before) throw new Error('Athlete not found');

  const values = normalizeInput(input);
  const now = new Date().toISOString();
  const correlationId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx
      .update(athletes)
      .set({ ...values, updatedAt: now })
      .where(and(eq(athletes.id, athleteId), eq(athletes.tenantId, tenantId), isNull(athletes.deletedAt)));

    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'athlete.updated',
      entityType: 'athlete',
      entityId: athleteId,
      source: 'WEB',
      correlationId,
      authProvider: actor.authProvider ?? null,
      sessionId: actor.sessionId ?? null,
      before,
      after: values,
    });
  });

  return getAthlete(db, tenantId, athleteId);
}
