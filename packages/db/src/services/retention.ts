import { assessAthleteRetention, type AthleteRetentionAssessment } from '@masters/domain';
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes, tenants, tests } from '../schema';

function testReferenceTime(test: {
  endedAt: string | null;
  startedAt: string | null;
  createdAt: string;
}): string {
  return test.endedAt ?? test.startedAt ?? test.createdAt;
}

/**
 * Read-only assessment of the retention boundary for irreversible athlete-data
 * processing. Soft deletion/use blocking remains independent and may happen
 * immediately after an approved request.
 */
export async function getAthleteRetentionAssessment(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<AthleteRetentionAssessment>> {
  const [tenant] = await db
    .select({ retentionYears: tenants.retentionYears })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error('Tenant not found');

  const [athlete] = await db
    .select({
      id: athletes.id,
      linkedUserId: athletes.linkedUserId,
      createdAt: athletes.createdAt,
    })
    .from(athletes)
    .where(and(
      eq(athletes.id, athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .limit(1);
  if (!athlete) throw new Error('Athlete not found');

  const athleteTests = await db
    .select({
      status: tests.status,
      endedAt: tests.endedAt,
      startedAt: tests.startedAt,
      createdAt: tests.createdAt,
    })
    .from(tests)
    .where(and(
      eq(tests.tenantId, tenantId),
      eq(tests.athleteId, athleteId),
      ne(tests.status, 'PLANNED'),
    ));

  return assessAthleteRetention({
    athleteCreatedAt: athlete.createdAt,
    linkedUserId: athlete.linkedUserId,
    testReferenceTimes: athleteTests.map(testReferenceTime),
    assessedAt,
  }, {
    tenantRetentionYears: tenant.retentionYears,
  });
}
