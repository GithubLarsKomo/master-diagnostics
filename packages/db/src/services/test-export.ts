import type { TestExportMeasurement, TestExportMetadata } from '@masters/domain';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athletes,
  protocolTemplateVersions,
  recoveryMeasurements,
  restMeasurements,
  testPlanSnapshots,
  testStages,
  tests,
  users,
} from '../schema';

export interface TestExportSource {
  metadata: TestExportMetadata;
  measurements: readonly TestExportMeasurement[];
}

export async function getTestExportSource(
  db: Database,
  tenantId: string,
  testId: string,
): Promise<TestExportSource | null> {
  const [context] = await db
    .select({
      testId: tests.id,
      testCreatedAt: tests.createdAt,
      testEndedAt: tests.endedAt,
      testReleasedAt: tests.releasedAt,
      status: tests.status,
      deviceType: tests.deviceType,
      athleteFirstName: athletes.firstName,
      athleteLastName: athletes.lastName,
      trainerName: users.displayName,
      protocolVersion: protocolTemplateVersions.versionNumber,
    })
    .from(tests)
    .innerJoin(athletes, and(
      eq(athletes.id, tests.athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .innerJoin(users, eq(users.id, tests.conductingTrainerUserId))
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .innerJoin(protocolTemplateVersions, and(
      eq(protocolTemplateVersions.id, testPlanSnapshots.protocolVersionId),
      eq(protocolTemplateVersions.tenantId, tenantId),
    ))
    .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
    .limit(1);

  if (!context) return null;

  const [restRows, stageRows, recoveryRows] = await Promise.all([
    db.select().from(restMeasurements).where(and(
      eq(restMeasurements.tenantId, tenantId),
      eq(restMeasurements.testId, testId),
    )).limit(1),
    db.select().from(testStages).where(and(
      eq(testStages.tenantId, tenantId),
      eq(testStages.testId, testId),
    )).orderBy(asc(testStages.stageNumber)),
    db.select().from(recoveryMeasurements).where(and(
      eq(recoveryMeasurements.tenantId, tenantId),
      eq(recoveryMeasurements.testId, testId),
    )).limit(1),
  ]);

  const measurements: TestExportMeasurement[] = [];
  const rest = restRows[0];
  if (rest) {
    measurements.push(Object.freeze({
      kind: 'REST',
      stageNumber: null,
      targetWatts: null,
      actualSeconds: null,
      heartRate: rest.heartRate,
      lactateValueX100: rest.lactateValueX100,
      lactateQualifier: rest.lactateQualifier,
      measuredAt: rest.measuredAt,
      qualityStatus: null,
      notes: null,
    }));
  }
  for (const stage of stageRows) {
    measurements.push(Object.freeze({
      kind: 'STAGE',
      stageNumber: stage.stageNumber,
      targetWatts: stage.targetWatts,
      actualSeconds: stage.actualSeconds,
      heartRate: stage.endHeartRate,
      lactateValueX100: stage.lactateValueX100,
      lactateQualifier: stage.lactateQualifier,
      measuredAt: stage.lactateMeasuredAt,
      qualityStatus: stage.qualityStatus,
      notes: stage.notes,
    }));
  }
  const recovery = recoveryRows[0];
  if (recovery) {
    measurements.push(Object.freeze({
      kind: 'RECOVERY',
      stageNumber: null,
      targetWatts: null,
      actualSeconds: null,
      heartRate: recovery.heartRate,
      lactateValueX100: recovery.lactateValueX100,
      lactateQualifier: recovery.lactateQualifier,
      measuredAt: recovery.measuredAt,
      qualityStatus: null,
      notes: null,
    }));
  }

  return Object.freeze({
    metadata: Object.freeze({
      testId: context.testId,
      athleteName: `${context.athleteFirstName} ${context.athleteLastName}`.trim(),
      testDate: context.testEndedAt ?? context.testReleasedAt ?? context.testCreatedAt,
      status: context.status,
      deviceType: context.deviceType,
      protocolVersion: String(context.protocolVersion),
      trainerName: context.trainerName,
    }),
    measurements: Object.freeze(measurements),
  });
}
