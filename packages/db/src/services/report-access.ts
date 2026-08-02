import type { AuthorizationContext } from '@masters/domain';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes, coachAthleteAssignments, tests } from '../schema';

/**
 * Checks whether a tenant-scoped user may read reports for one test.
 * Tenant admins may read all tenant tests; trainers require an active athlete
 * assignment; athletes may read only tests linked to their own user account.
 */
export async function canReadReportForTest(
  db: Database,
  context: AuthorizationContext,
  testId: string,
  now = new Date().toISOString(),
): Promise<boolean> {
  if (context.role === 'TENANT_ADMIN') {
    const [row] = await db
      .select({ id: tests.id })
      .from(tests)
      .where(and(eq(tests.id, testId), eq(tests.tenantId, context.tenantId)))
      .limit(1);
    return Boolean(row);
  }

  if (context.role === 'TRAINER') {
    const [row] = await db
      .select({ id: tests.id })
      .from(tests)
      .innerJoin(
        coachAthleteAssignments,
        and(
          eq(coachAthleteAssignments.athleteId, tests.athleteId),
          eq(coachAthleteAssignments.tenantId, context.tenantId),
        ),
      )
      .where(and(
        eq(tests.id, testId),
        eq(tests.tenantId, context.tenantId),
        eq(coachAthleteAssignments.coachUserId, context.userId),
        lte(coachAthleteAssignments.validFrom, now),
        or(isNull(coachAthleteAssignments.validUntil), gte(coachAthleteAssignments.validUntil, now)),
      ))
      .limit(1);
    return Boolean(row);
  }

  if (context.role === 'ATHLETE') {
    const [row] = await db
      .select({ id: tests.id })
      .from(tests)
      .innerJoin(
        athletes,
        and(eq(athletes.id, tests.athleteId), eq(athletes.tenantId, context.tenantId)),
      )
      .where(and(
        eq(tests.id, testId),
        eq(tests.tenantId, context.tenantId),
        eq(athletes.linkedUserId, context.userId),
      ))
      .limit(1);
    return Boolean(row);
  }

  return false;
}
