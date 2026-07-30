import { planTestFromExpectedLt2, type Lt2TestPlanInput } from '@masters/domain';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteSnapshots,
  athletes,
  auditEvents,
  coachAthleteAssignments,
  protocolTemplates,
  protocolTemplateVersions,
  testPlanSnapshots,
  tests,
} from '../schema';

export interface TestPlanActor {
  userId: string;
  role: string;
}

export interface CreateTestPlanSnapshotInput {
  athleteId: string;
  protocolVersionId: string;
  expectedLt2Watts: number;
  stageCount?: number;
  startPowerWatts?: number;
  incrementWatts?: number;
  scheduledAt?: string | null;
}

function requirePlanningRole(actor: TestPlanActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may plan tests');
  }
}

function buildPlanningInput(input: CreateTestPlanSnapshotInput): Lt2TestPlanInput {
  return {
    expectedLt2Watts: input.expectedLt2Watts,
    ...(input.stageCount === undefined ? {} : { stageCount: input.stageCount }),
    ...(input.startPowerWatts === undefined ? {} : { startPowerWatts: input.startPowerWatts }),
    ...(input.incrementWatts === undefined ? {} : { incrementWatts: input.incrementWatts }),
  };
}

export async function createTestPlanSnapshot(
  db: Database,
  tenantId: string,
  actor: TestPlanActor,
  input: CreateTestPlanSnapshotInput,
) {
  requirePlanningRole(actor);
  if (input.scheduledAt && Number.isNaN(Date.parse(input.scheduledAt))) {
    throw new Error('Scheduled time must be an ISO timestamp');
  }

  const plan = planTestFromExpectedLt2(buildPlanningInput(input));
  const now = new Date().toISOString();
  const testId = crypto.randomUUID();
  const athleteSnapshotId = crypto.randomUUID();
  const planSnapshotId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const [athlete] = await tx
      .select()
      .from(athletes)
      .where(and(
        eq(athletes.id, input.athleteId),
        eq(athletes.tenantId, tenantId),
        isNull(athletes.deletedAt),
      ))
      .limit(1);
    if (!athlete) {
      throw new Error('Athlete not found');
    }
    if (athlete.consentBlockedAt) {
      throw new Error('Athlete is blocked from diagnostic use');
    }

    if (actor.role === 'TRAINER') {
      const [assignment] = await tx
        .select({ id: coachAthleteAssignments.id })
        .from(coachAthleteAssignments)
        .where(and(
          eq(coachAthleteAssignments.tenantId, tenantId),
          eq(coachAthleteAssignments.athleteId, input.athleteId),
          eq(coachAthleteAssignments.coachUserId, actor.userId),
          isNull(coachAthleteAssignments.validUntil),
        ))
        .limit(1);
      if (!assignment) {
        throw new Error('Trainer is not assigned to athlete');
      }
    }

    const [protocol] = await tx
      .select({
        version: protocolTemplateVersions,
        template: protocolTemplates,
      })
      .from(protocolTemplateVersions)
      .innerJoin(protocolTemplates, and(
        eq(protocolTemplates.id, protocolTemplateVersions.templateId),
        eq(protocolTemplates.tenantId, tenantId),
      ))
      .where(and(
        eq(protocolTemplateVersions.id, input.protocolVersionId),
        eq(protocolTemplateVersions.tenantId, tenantId),
        eq(protocolTemplates.active, true),
      ))
      .limit(1);
    if (!protocol) {
      throw new Error('Active protocol template version not found');
    }

    let protocolConfig: { deviceType?: string } = {};
    try {
      protocolConfig = JSON.parse(protocol.version.configJson) as { deviceType?: string };
    } catch {
      throw new Error('Protocol template version configuration is invalid');
    }
    const deviceType = protocolConfig.deviceType ?? protocol.template.deviceType;
    if (deviceType !== 'BIKEERG' && deviceType !== 'ROWERG' && deviceType !== 'RP3') {
      throw new Error('Protocol template version device type is invalid');
    }

    const [latestAthleteSnapshot] = await tx
      .select({ version: athleteSnapshots.version })
      .from(athleteSnapshots)
      .where(and(
        eq(athleteSnapshots.tenantId, tenantId),
        eq(athleteSnapshots.athleteId, input.athleteId),
      ))
      .orderBy(desc(athleteSnapshots.version))
      .limit(1);
    const athleteSnapshot = {
      id: athleteSnapshotId,
      tenantId,
      athleteId: input.athleteId,
      snapshotJson: JSON.stringify(athlete),
      version: (latestAthleteSnapshot?.version ?? 0) + 1,
      createdAt: now,
      updatedAt: now,
    };
    const test: typeof tests.$inferInsert = {
      id: testId,
      tenantId,
      athleteId: input.athleteId,
      deviceType,
      status: 'PLANNED' as const,
      conductingTrainerUserId: actor.userId,
      scheduledAt: input.scheduledAt ?? null,
      startedAt: null,
      endedAt: null,
      currentVersion: 1,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const planSnapshot = {
      id: planSnapshotId,
      tenantId,
      testId,
      protocolVersionId: input.protocolVersionId,
      athleteSnapshotId,
      expectedLt2Watts: input.expectedLt2Watts,
      startWatts: plan.startPowerWatts,
      incrementWatts: plan.incrementWatts,
      maximumStages: plan.stageCount,
      snapshotJson: JSON.stringify({
        schemaVersion: 1,
        athlete,
        protocolTemplate: protocol.template,
        protocolVersion: protocol.version,
        plan,
      }),
      createdAt: now,
      updatedAt: now,
    };

    await tx.insert(athleteSnapshots).values(athleteSnapshot);
    await tx.insert(tests).values(test);
    await tx.insert(testPlanSnapshots).values(planSnapshot);
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId,
      occurredAt: now,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'test.plan_snapshot_created',
      entityType: 'test_plan_snapshot',
      entityId: planSnapshotId,
      source: 'WEB',
      correlationId,
      afterJson: JSON.stringify({
        testId,
        athleteId: input.athleteId,
        athleteSnapshotId,
        protocolVersionId: input.protocolVersionId,
        algorithmVersion: plan.algorithmVersion,
        warningCodes: plan.warnings.map((warning) => warning.code),
      }),
      createdAt: now,
      updatedAt: now,
    });

    return { test, athleteSnapshot, planSnapshot, plan };
  });
}

export async function getTestPlanSnapshot(
  db: Database,
  tenantId: string,
  testId: string,
) {
  const [snapshot] = await db
    .select()
    .from(testPlanSnapshots)
    .where(and(
      eq(testPlanSnapshots.tenantId, tenantId),
      eq(testPlanSnapshots.testId, testId),
    ))
    .limit(1);
  return snapshot ?? null;
}
