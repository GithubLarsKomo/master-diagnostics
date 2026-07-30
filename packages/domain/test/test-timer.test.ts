import { describe, expect, it } from 'vitest';
import {
  buildTestTimerPlan,
  getCrossedTestTimerWarnings,
  getTestTimerPosition,
} from '../src/test-timer';

const standardPlan = () => buildTestTimerPlan({
  warmupSeconds: 600,
  readinessSeconds: 120,
  stageSeconds: 240,
  pauseSeconds: 60,
  sampleTargetSeconds: 30,
  recoverySeconds: 300,
  stageTargetsWatts: [210, 245, 280, 315, 350, 385, 420],
  warningSeconds: [30, 10, 3],
});

describe('test timer core', () => {
  it('builds the specification sequence including the final measurement pause and recovery', () => {
    const plan = standardPlan();

    expect(plan).toMatchObject({
      schemaVersion: 1,
      stageCount: 7,
      totalDurationSeconds: 3_120,
      warningSeconds: [30, 10, 3],
    });
    expect(plan.phases).toHaveLength(17);
    expect(plan.phases.map((phase) => phase.kind)).toEqual([
      'WARMUP',
      'READINESS',
      'STAGE', 'MEASUREMENT_PAUSE',
      'STAGE', 'MEASUREMENT_PAUSE',
      'STAGE', 'MEASUREMENT_PAUSE',
      'STAGE', 'MEASUREMENT_PAUSE',
      'STAGE', 'MEASUREMENT_PAUSE',
      'STAGE', 'MEASUREMENT_PAUSE',
      'STAGE', 'MEASUREMENT_PAUSE',
      'RECOVERY',
    ]);
    expect(plan.phases[2]).toMatchObject({
      id: 'stage-1',
      stageNumber: 1,
      targetWatts: 210,
      startsAtSeconds: 720,
      endsAtSeconds: 960,
    });
    expect(plan.phases[15]).toMatchObject({
      id: 'measurement-pause-7',
      stageNumber: 7,
      startsAtSeconds: 2_760,
      endsAtSeconds: 2_820,
      sampleTargetSeconds: 30,
    });
    expect(plan.phases[16]).toMatchObject({
      id: 'recovery',
      startsAtSeconds: 2_820,
      endsAtSeconds: 3_120,
    });
  });

  it('resolves exact boundaries, next targets and the sample window deterministically', () => {
    const plan = standardPlan();

    expect(getTestTimerPosition(plan, 0)).toMatchObject({
      phase: { kind: 'WARMUP' },
      phaseRemainingSeconds: 600,
      nextStageTargetWatts: 210,
    });
    expect(getTestTimerPosition(plan, 600)).toMatchObject({
      phase: { kind: 'READINESS' },
      phaseElapsedSeconds: 0,
      nextStageTargetWatts: 210,
    });
    expect(getTestTimerPosition(plan, 720)).toMatchObject({
      phase: { kind: 'STAGE', stageNumber: 1, targetWatts: 210 },
      phaseRemainingSeconds: 240,
      nextStageTargetWatts: 245,
    });
    expect(getTestTimerPosition(plan, 970)).toMatchObject({
      phase: { kind: 'MEASUREMENT_PAUSE', stageNumber: 1 },
      phaseElapsedSeconds: 10,
      sampleWindowRemainingSeconds: 20,
      nextStageTargetWatts: 245,
    });
    expect(getTestTimerPosition(plan, 3_120)).toEqual({
      completed: true,
      phase: null,
      phaseElapsedSeconds: 0,
      phaseRemainingSeconds: 0,
      totalElapsedSeconds: 3_120,
      totalRemainingSeconds: 0,
      nextStageTargetWatts: null,
      sampleWindowRemainingSeconds: null,
    });
  });

  it('emits each crossed stage warning once even when time advances in large steps', () => {
    const plan = standardPlan();

    expect(getCrossedTestTimerWarnings(plan, 929, 958)).toEqual([
      { type: 'STAGE_END_WARNING', stageNumber: 1, secondsRemaining: 30, atElapsedSeconds: 930 },
      { type: 'STAGE_END_WARNING', stageNumber: 1, secondsRemaining: 10, atElapsedSeconds: 950 },
      { type: 'STAGE_END_WARNING', stageNumber: 1, secondsRemaining: 3, atElapsedSeconds: 957 },
    ]);
    expect(getCrossedTestTimerWarnings(plan, 930, 950)).toEqual([
      { type: 'STAGE_END_WARNING', stageNumber: 1, secondsRemaining: 10, atElapsedSeconds: 950 },
    ]);
    expect(getCrossedTestTimerWarnings(plan, 950, 950)).toEqual([]);
  });

  it('supports versioned zero-duration optional phases without zero-length timer states', () => {
    const plan = buildTestTimerPlan({
      warmupSeconds: 0,
      readinessSeconds: 0,
      stageSeconds: 120,
      pauseSeconds: 30,
      sampleTargetSeconds: 15,
      recoverySeconds: 300,
      stageTargetsWatts: [100],
    });

    expect(plan.phases.map((phase) => phase.kind)).toEqual([
      'STAGE',
      'MEASUREMENT_PAUSE',
      'RECOVERY',
    ]);
    expect(plan.totalDurationSeconds).toBe(450);
  });

  it('rejects malformed or unsafe timer inputs', () => {
    expect(() => buildTestTimerPlan({
      warmupSeconds: 600,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 61,
      recoverySeconds: 300,
      stageTargetsWatts: [210],
    })).toThrow('Sample target seconds');

    expect(() => buildTestTimerPlan({
      warmupSeconds: 600,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 30,
      recoverySeconds: 240,
      stageTargetsWatts: [210],
    })).toThrow('Recovery seconds must remain fixed at 300');

    const plan = standardPlan();
    expect(() => getTestTimerPosition(plan, Number.NaN)).toThrow('non-negative finite');
    expect(() => getCrossedTestTimerWarnings(plan, 10, 9)).toThrow('may not move backwards');
  });
});
