import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { testStages, tests } from '../schema';

export interface AthleteLactateCurvePoint {
  testId: string;
  stageNumber: number;
  watts: number;
  lactateValueX100: number;
  qualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';
}

export interface AthleteLactateCurveSeries {
  testId: string;
  createdAt: string;
  points: ReadonlyArray<AthleteLactateCurvePoint>;
}

function toCurvePoint(row: {
  testId: string;
  stageNumber: number;
  targetWatts: number;
  endWatts: number | null;
  meanWatts: number | null;
  lactateValueX100: number | null;
  qualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  qualityStatus: string;
}): AthleteLactateCurvePoint | null {
  if (row.lactateValueX100 === null || row.qualifier === null || row.qualityStatus === 'MISSING' || row.qualityStatus === 'EXCLUDED') return null;
  return Object.freeze({
    testId: row.testId,
    stageNumber: row.stageNumber,
    watts: row.endWatts ?? row.meanWatts ?? row.targetWatts,
    lactateValueX100: row.lactateValueX100,
    qualifier: row.qualifier,
  });
}

export async function getRecentAthleteLactateCurves(
  db: Database,
  tenantId: string,
  athleteId: string,
  limit = 5,
): Promise<ReadonlyArray<AthleteLactateCurveSeries>> {
  const recentTests = await db
    .select({ id: tests.id, createdAt: tests.createdAt })
    .from(tests)
    .where(and(eq(tests.tenantId, tenantId), eq(tests.athleteId, athleteId)))
    .orderBy(desc(tests.createdAt))
    .limit(Math.min(Math.max(limit, 1), 5));

  if (recentTests.length === 0) return Object.freeze([]);

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
    .where(and(eq(testStages.tenantId, tenantId), inArray(testStages.testId, recentTests.map((test) => test.id))))
    .orderBy(asc(testStages.stageNumber));

  return Object.freeze(recentTests.map((test) => Object.freeze({
    testId: test.id,
    createdAt: test.createdAt,
    points: Object.freeze(rows
      .filter((row) => row.testId === test.id)
      .map(toCurvePoint)
      .filter((point): point is AthleteLactateCurvePoint => point !== null)),
  })));
}

export async function getLatestAthleteLactateCurve(
  db: Database,
  tenantId: string,
  athleteId: string,
): Promise<ReadonlyArray<AthleteLactateCurvePoint>> {
  const [latest] = await getRecentAthleteLactateCurves(db, tenantId, athleteId, 1);
  return latest?.points ?? Object.freeze([]);
}
