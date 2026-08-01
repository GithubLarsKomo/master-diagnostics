import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { testStages, tests } from '../schema';

export interface AthleteLactateCurvePoint {
  testId: string;
  stageNumber: number;
  watts: number;
  lactateValueX100: number;
  qualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';
}

export async function getLatestAthleteLactateCurve(
  db: Database,
  tenantId: string,
  athleteId: string,
): Promise<ReadonlyArray<AthleteLactateCurvePoint>> {
  const [latestTest] = await db
    .select({ id: tests.id })
    .from(tests)
    .where(and(eq(tests.tenantId, tenantId), eq(tests.athleteId, athleteId)))
    .orderBy(desc(tests.createdAt))
    .limit(1);

  if (!latestTest) return Object.freeze([]);

  const rows = await db
    .select({
      testId: testStages.testId,
      stageNumber: testStages.stageNumber,
      targetWatts: testStages.targetWatts,
      endWatts: testStages.endWatts,
      meanWatts: testStages.meanWatts,
      lactateValueX100: testStages.lactateValueX100,
      qualifier: testStages.lactateQualifier,
      qualityStatus: testStages.qualityStatus,
    })
    .from(testStages)
    .where(and(
      eq(testStages.tenantId, tenantId),
      eq(testStages.testId, latestTest.id),
    ))
    .orderBy(asc(testStages.stageNumber));

  return Object.freeze(rows
    .filter((row) => row.lactateValueX100 !== null && row.qualifier !== null && row.qualityStatus !== 'MISSING' && row.qualityStatus !== 'EXCLUDED')
    .map((row) => Object.freeze({
      testId: row.testId,
      stageNumber: row.stageNumber,
      watts: row.endWatts ?? row.meanWatts ?? row.targetWatts,
      lactateValueX100: row.lactateValueX100!,
      qualifier: row.qualifier!,
    })));
}
