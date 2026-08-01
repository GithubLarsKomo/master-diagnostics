import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes, coachAthleteAssignments, testPlanSnapshots, tests } from '../schema';

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

export interface DashboardTestActor {
  userId: string;
  role: string;
}

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

export function listTestsForTrainerDashboard(
  db: Database,
  tenantId: string,
  actor: DashboardTestActor,
) {
  const base = db
    .select(executionSelection)
    .from(tests)
    .innerJoin(athletes, and(
      eq(athletes.id, tests.athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ));

  if (actor.role === 'TRAINER') {
    return base
      .innerJoin(coachAthleteAssignments, and(
        eq(coachAthleteAssignments.tenantId, tenantId),
        eq(coachAthleteAssignments.athleteId, athletes.id),
        eq(coachAthleteAssignments.coachUserId, actor.userId),
        isNull(coachAthleteAssignments.validUntil),
      ))
      .where(eq(tests.tenantId, tenantId))
      .orderBy(desc(tests.createdAt));
  }

  if (actor.role !== 'TENANT_ADMIN') {
    throw new Error('Trainer dashboard is only available to trainers and tenant admins');
  }

  return base
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
