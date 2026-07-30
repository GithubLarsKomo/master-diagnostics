import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes, testPlanSnapshots, tests } from '../schema';

const executionSelection = {
  test: tests,
  athlete: {
    id: athletes.id,
    firstName: athletes.firstName,
    lastName: athletes.lastName,
  },
  plan: {
    expectedLt2Watts: testPlanSnapshots.expectedLt2Watts,
    startWatts: testPlanSnapshots.startWatts,
    incrementWatts: testPlanSnapshots.incrementWatts,
    maximumStages: testPlanSnapshots.maximumStages,
  },
};

export function listTestsForExecution(db: Database, tenantId: string) {
  return db
    .select(executionSelection)
    .from(tests)
    .innerJoin(athletes, and(
      eq(athletes.id, tests.athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .where(eq(tests.tenantId, tenantId))
    .orderBy(desc(tests.createdAt));
}

export async function getTestForExecution(
  db: Database,
  tenantId: string,
  testId: string,
) {
  const [context] = await db
    .select(executionSelection)
    .from(tests)
    .innerJoin(athletes, and(
      eq(athletes.id, tests.athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
    .limit(1);
  return context ?? null;
}
