import {
  buildTestTimerPlan,
  type TestTimerPlan,
} from '@masters/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { testPlanSnapshots, tests } from '../schema';

export interface TestTimerActor {
  userId: string;
  role: string;
}

interface FrozenTimerSnapshot {
  protocolVersion?: {
    warmupSeconds?: unknown;
    readinessSeconds?: unknown;
    stageSeconds?: unknown;
    pauseSeconds?: unknown;
    sampleTargetSeconds?: unknown;
    recoverySeconds?: unknown;
    configJson?: unknown;
  };
  plan?: {
    powersWatts?: unknown;
  };
}

function requireTimerRole(actor: TestTimerActor): void {
  if (actor.role !== 'TRAINER' && actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only trainers and tenant admins may load test timers');
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Immutable test plan snapshot is missing ${field}`);
  }
  return value;
}

function parseWarningSeconds(configJson: unknown): readonly number[] | undefined {
  if (typeof configJson !== 'string') {
    throw new Error('Immutable protocol configuration is missing');
  }
  let config: { audioWarningSeconds?: unknown };
  try {
    config = JSON.parse(configJson) as { audioWarningSeconds?: unknown };
  } catch {
    throw new Error('Immutable protocol configuration is invalid');
  }
  if (config.audioWarningSeconds === undefined) return undefined;
  if (
    !Array.isArray(config.audioWarningSeconds)
    || config.audioWarningSeconds.some((value) => typeof value !== 'number')
  ) {
    throw new Error('Immutable protocol warning configuration is invalid');
  }
  return config.audioWarningSeconds as number[];
}

function buildTimerFromSnapshot(
  snapshotJson: string,
  expectedStageCount: number,
): TestTimerPlan {
  let frozen: FrozenTimerSnapshot;
  try {
    frozen = JSON.parse(snapshotJson) as FrozenTimerSnapshot;
  } catch {
    throw new Error('Immutable test plan snapshot is invalid');
  }
  if (!frozen.protocolVersion || !frozen.plan || !Array.isArray(frozen.plan.powersWatts)) {
    throw new Error('Immutable test plan snapshot has no timer configuration');
  }
  if (frozen.plan.powersWatts.length !== expectedStageCount) {
    throw new Error('Immutable test plan snapshot stage count is inconsistent');
  }

  return buildTestTimerPlan({
    warmupSeconds: requireNumber(frozen.protocolVersion.warmupSeconds, 'warm-up seconds'),
    readinessSeconds: requireNumber(frozen.protocolVersion.readinessSeconds, 'readiness seconds'),
    stageSeconds: requireNumber(frozen.protocolVersion.stageSeconds, 'stage seconds'),
    pauseSeconds: requireNumber(frozen.protocolVersion.pauseSeconds, 'pause seconds'),
    sampleTargetSeconds: requireNumber(
      frozen.protocolVersion.sampleTargetSeconds,
      'sample target seconds',
    ),
    recoverySeconds: requireNumber(frozen.protocolVersion.recoverySeconds, 'recovery seconds'),
    stageTargetsWatts: frozen.plan.powersWatts.map((value) => (
      requireNumber(value, 'stage target watts')
    )),
    warningSeconds: parseWarningSeconds(frozen.protocolVersion.configJson),
  });
}

export async function getTestTimerPlan(
  db: Database,
  tenantId: string,
  actor: TestTimerActor,
  testId: string,
): Promise<TestTimerPlan> {
  requireTimerRole(actor);

  const [context] = await db
    .select({ test: tests, snapshot: testPlanSnapshots })
    .from(tests)
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .where(and(eq(tests.id, testId), eq(tests.tenantId, tenantId)))
    .limit(1);
  if (!context) {
    throw new Error('Test timer context not found');
  }
  if (context.test.conductingTrainerUserId !== actor.userId) {
    throw new Error('Only the conducting trainer may load the test timer');
  }

  return buildTimerFromSnapshot(
    context.snapshot.snapshotJson,
    context.snapshot.maximumStages,
  );
}
