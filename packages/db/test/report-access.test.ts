import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@masters/domain';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { canReadReportForTest } from '../src/services/report-access';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-report-access-${crypto.randomUUID()}.db` });
  await client.batch([
    `CREATE TABLE athletes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, linked_user_id TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, birth_date TEXT NOT NULL, reference_category TEXT NOT NULL, height_cm INTEGER NOT NULL, current_weight_kg_x100 INTEGER NOT NULL, primary_sport TEXT NOT NULL, primary_discipline TEXT NOT NULL, training_status TEXT NOT NULL, consent_blocked_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, device_type TEXT NOT NULL, status TEXT NOT NULL, conducting_trainer_user_id TEXT NOT NULL, scheduled_at TEXT, started_at TEXT, ended_at TEXT, version INTEGER NOT NULL, released_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE coach_athlete_assignments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, athlete_id TEXT NOT NULL, coach_user_id TEXT NOT NULL, is_primary INTEGER NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

function context(role: AuthorizationContext['role'], userId: string, tenantId = 'tenant-a'): AuthorizationContext {
  return { role, userId, tenantId };
}

describe('report resource access', () => {
  let db: Database;
  const now = '2026-08-02T12:00:00.000Z';

  beforeEach(async () => {
    db = await createTestDatabase();
    await db.insert(schema.athletes).values({
      id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: 'athlete-user', firstName: 'Max', lastName: 'Test', birthDate: '2000-01-01', referenceCategory: 'MALE_20_29', heightCm: 180, currentWeightKgX100: 7500, primarySport: 'ROWING', primaryDiscipline: '2000M', trainingStatus: 'TRAINED', createdAt: now, updatedAt: now,
    });
    await db.insert(schema.tests).values({
      id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED', conductingTrainerUserId: 'trainer-user', currentVersion: 1, releasedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.coachAthleteAssignments).values({
      id: 'assignment-a', tenantId: 'tenant-a', athleteId: 'athlete-a', coachUserId: 'trainer-user', isPrimary: true, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, createdAt: now, updatedAt: now,
    });
  });

  it('allows tenant admin, assigned trainer and linked athlete only inside their tenant resource boundary', async () => {
    await expect(canReadReportForTest(db, context('TENANT_ADMIN', 'admin'), 'test-a', now)).resolves.toBe(true);
    await expect(canReadReportForTest(db, context('TRAINER', 'trainer-user'), 'test-a', now)).resolves.toBe(true);
    await expect(canReadReportForTest(db, context('ATHLETE', 'athlete-user'), 'test-a', now)).resolves.toBe(true);

    await expect(canReadReportForTest(db, context('TRAINER', 'other-trainer'), 'test-a', now)).resolves.toBe(false);
    await expect(canReadReportForTest(db, context('ATHLETE', 'other-athlete'), 'test-a', now)).resolves.toBe(false);
    await expect(canReadReportForTest(db, context('TENANT_ADMIN', 'admin', 'tenant-b'), 'test-a', now)).resolves.toBe(false);
    await expect(canReadReportForTest(db, context('PLATFORM_ADMIN', 'platform-admin'), 'test-a', now)).resolves.toBe(false);
  });
});
