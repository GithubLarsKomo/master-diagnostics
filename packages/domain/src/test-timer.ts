export const DEFAULT_TEST_TIMER_WARNING_SECONDS = [30, 10, 3] as const;

export type TestTimerPhaseKind =
  | 'WARMUP'
  | 'READINESS'
  | 'STAGE'
  | 'MEASUREMENT_PAUSE'
  | 'RECOVERY';

export interface TestTimerPlanInput {
  warmupSeconds: number;
  readinessSeconds: number;
  stageSeconds: number;
  pauseSeconds: number;
  sampleTargetSeconds: number;
  recoverySeconds: number;
  stageTargetsWatts: readonly number[];
  warningSeconds?: readonly number[];
}

export interface TestTimerPhase {
  id: string;
  kind: TestTimerPhaseKind;
  stageNumber: number | null;
  targetWatts: number | null;
  durationSeconds: number;
  startsAtSeconds: number;
  endsAtSeconds: number;
  sampleTargetSeconds: number | null;
}

export interface TestTimerPlan {
  schemaVersion: 1;
  phases: readonly TestTimerPhase[];
  stageCount: number;
  totalDurationSeconds: number;
  warningSeconds: readonly number[];
}

export interface TestTimerPosition {
  completed: boolean;
  phase: TestTimerPhase | null;
  phaseElapsedSeconds: number;
  phaseRemainingSeconds: number;
  totalElapsedSeconds: number;
  totalRemainingSeconds: number;
  nextStageTargetWatts: number | null;
  sampleWindowRemainingSeconds: number | null;
}

export interface TestTimerWarning {
  type: 'STAGE_END_WARNING';
  stageNumber: number;
  secondsRemaining: number;
  atElapsedSeconds: number;
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
}

function normalizeWarnings(
  warningSeconds: readonly number[] | undefined,
  stageSeconds: number,
): number[] {
  const values = [...(warningSeconds ?? DEFAULT_TEST_TIMER_WARNING_SECONDS)];
  if (
    values.some((value) => !Number.isInteger(value) || value <= 0 || value >= stageSeconds)
  ) {
    throw new Error('Timer warning seconds must be positive integers below the stage duration');
  }
  return [...new Set(values)].sort((left, right) => right - left);
}

export function buildTestTimerPlan(input: TestTimerPlanInput): TestTimerPlan {
  requireIntegerInRange(input.warmupSeconds, 0, 3_600, 'Warm-up seconds');
  requireIntegerInRange(input.readinessSeconds, 0, 600, 'Readiness seconds');
  requireIntegerInRange(input.stageSeconds, 60, 1_800, 'Stage seconds');
  requireIntegerInRange(input.pauseSeconds, 1, 600, 'Pause seconds');
  requireIntegerInRange(
    input.sampleTargetSeconds,
    1,
    input.pauseSeconds,
    'Sample target seconds',
  );
  if (input.recoverySeconds !== 300) {
    throw new Error('Recovery seconds must remain fixed at 300');
  }
  if (input.stageTargetsWatts.length < 1 || input.stageTargetsWatts.length > 12) {
    throw new Error('Timer plan must contain between 1 and 12 stages');
  }
  if (
    input.stageTargetsWatts.some(
      (watts) => !Number.isInteger(watts) || watts < 1 || watts > 2_000,
    )
  ) {
    throw new Error('Stage targets must be integer watts between 1 and 2000');
  }

  const warningSeconds = normalizeWarnings(input.warningSeconds, input.stageSeconds);
  const phases: TestTimerPhase[] = [];
  let cursor = 0;
  const appendPhase = (
    id: string,
    kind: TestTimerPhaseKind,
    durationSeconds: number,
    stageNumber: number | null,
    targetWatts: number | null,
    sampleTargetSeconds: number | null = null,
  ) => {
    if (durationSeconds === 0) return;
    phases.push({
      id,
      kind,
      stageNumber,
      targetWatts,
      durationSeconds,
      startsAtSeconds: cursor,
      endsAtSeconds: cursor + durationSeconds,
      sampleTargetSeconds,
    });
    cursor += durationSeconds;
  };

  appendPhase('warmup', 'WARMUP', input.warmupSeconds, null, null);
  appendPhase('readiness', 'READINESS', input.readinessSeconds, null, null);
  input.stageTargetsWatts.forEach((targetWatts, index) => {
    const stageNumber = index + 1;
    appendPhase(
      `stage-${stageNumber}`,
      'STAGE',
      input.stageSeconds,
      stageNumber,
      targetWatts,
    );
    appendPhase(
      `measurement-pause-${stageNumber}`,
      'MEASUREMENT_PAUSE',
      input.pauseSeconds,
      stageNumber,
      null,
      input.sampleTargetSeconds,
    );
  });
  appendPhase('recovery', 'RECOVERY', input.recoverySeconds, null, null);

  return {
    schemaVersion: 1,
    phases,
    stageCount: input.stageTargetsWatts.length,
    totalDurationSeconds: cursor,
    warningSeconds,
  };
}

function requireElapsedSeconds(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
}

export function getTestTimerPosition(
  plan: TestTimerPlan,
  activeElapsedSeconds: number,
): TestTimerPosition {
  requireElapsedSeconds(activeElapsedSeconds, 'Active elapsed seconds');
  const totalElapsedSeconds = Math.min(activeElapsedSeconds, plan.totalDurationSeconds);
  const phaseIndex = plan.phases.findIndex(
    (candidate) => totalElapsedSeconds < candidate.endsAtSeconds,
  );
  if (phaseIndex === -1) {
    return {
      completed: true,
      phase: null,
      phaseElapsedSeconds: 0,
      phaseRemainingSeconds: 0,
      totalElapsedSeconds,
      totalRemainingSeconds: 0,
      nextStageTargetWatts: null,
      sampleWindowRemainingSeconds: null,
    };
  }

  const phase = plan.phases[phaseIndex]!;
  const phaseElapsedSeconds = totalElapsedSeconds - phase.startsAtSeconds;
  const nextStage = plan.phases
    .slice(phaseIndex + 1)
    .find((candidate) => candidate.kind === 'STAGE');

  return {
    completed: false,
    phase,
    phaseElapsedSeconds,
    phaseRemainingSeconds: phase.endsAtSeconds - totalElapsedSeconds,
    totalElapsedSeconds,
    totalRemainingSeconds: plan.totalDurationSeconds - totalElapsedSeconds,
    nextStageTargetWatts: nextStage?.targetWatts ?? null,
    sampleWindowRemainingSeconds: phase.kind === 'MEASUREMENT_PAUSE'
      ? Math.max(0, (phase.sampleTargetSeconds ?? 0) - phaseElapsedSeconds)
      : null,
  };
}

export function getCrossedTestTimerWarnings(
  plan: TestTimerPlan,
  previousActiveElapsedSeconds: number,
  activeElapsedSeconds: number,
): TestTimerWarning[] {
  requireElapsedSeconds(previousActiveElapsedSeconds, 'Previous active elapsed seconds');
  requireElapsedSeconds(activeElapsedSeconds, 'Active elapsed seconds');
  if (activeElapsedSeconds < previousActiveElapsedSeconds) {
    throw new Error('Active elapsed seconds may not move backwards');
  }

  return plan.phases
    .filter((phase) => phase.kind === 'STAGE')
    .flatMap((phase) => plan.warningSeconds.map((secondsRemaining) => ({
      type: 'STAGE_END_WARNING' as const,
      stageNumber: phase.stageNumber!,
      secondsRemaining,
      atElapsedSeconds: phase.endsAtSeconds - secondsRemaining,
    })))
    .filter(
      (warning) => (
        previousActiveElapsedSeconds < warning.atElapsedSeconds
        && warning.atElapsedSeconds <= activeElapsedSeconds
      ),
    )
    .sort((left, right) => left.atElapsedSeconds - right.atElapsedSeconds);
}
