export const LT2_TARGET_STAGE = 5;
export const DEFAULT_STAGE_COUNT = 7;

export type TestPlanWarningCode =
  | 'EXPECTED_LT2_ROUNDED'
  | 'EXPECTED_LT2_IMPLAUSIBLE'
  | 'STAGE_COUNT_TOO_SHORT'
  | 'STAGE_COUNT_TOO_LONG'
  | 'POWER_SEQUENCE_IMPLAUSIBLE';

export interface TestPlanWarning {
  code: TestPlanWarningCode;
  severity: 'INFO' | 'WARNING';
  message: string;
}

export interface Lt2TestPlanInput {
  expectedLt2Watts: number;
  stageCount?: number;
}

export interface Lt2TestPlan {
  algorithmVersion: 'LT2_PLAN_V1';
  expectedLt2Watts: number;
  plannedLt2Watts: number;
  targetLt2Stage: typeof LT2_TARGET_STAGE;
  stageCount: number;
  startPowerWatts: number;
  incrementWatts: number;
  powersWatts: number[];
  warnings: TestPlanWarning[];
}

export function roundWattsToFive(watts: number): number {
  if (!Number.isFinite(watts)) {
    throw new Error('Power must be finite');
  }
  return Math.round(watts / 5) * 5;
}

export function planTestFromExpectedLt2(input: Lt2TestPlanInput): Lt2TestPlan {
  const { expectedLt2Watts } = input;
  const stageCount = input.stageCount ?? DEFAULT_STAGE_COUNT;

  if (!Number.isFinite(expectedLt2Watts) || expectedLt2Watts < 25 || expectedLt2Watts > 2_000) {
    throw new Error('Expected LT2 must be between 25 and 2000 watts');
  }
  if (!Number.isInteger(stageCount) || stageCount < LT2_TARGET_STAGE || stageCount > 12) {
    throw new Error('Stage count must be an integer between 5 and 12');
  }

  const plannedLt2Watts = roundWattsToFive(expectedLt2Watts);
  const idealStartPowerWatts = expectedLt2Watts * 0.6;
  const incrementWatts = Math.max(
    5,
    roundWattsToFive(
      (plannedLt2Watts - idealStartPowerWatts) / (LT2_TARGET_STAGE - 1),
    ),
  );
  const startPowerWatts = plannedLt2Watts - incrementWatts * (LT2_TARGET_STAGE - 1);
  if (startPowerWatts <= 0) {
    throw new Error('Expected LT2 does not produce a positive start power');
  }

  const powersWatts = Array.from(
    { length: stageCount },
    (_, index) => startPowerWatts + index * incrementWatts,
  );
  const warnings: TestPlanWarning[] = [];

  if (plannedLt2Watts !== expectedLt2Watts) {
    warnings.push({
      code: 'EXPECTED_LT2_ROUNDED',
      severity: 'INFO',
      message: `Expected LT2 was rounded from ${expectedLt2Watts} W to ${plannedLt2Watts} W`,
    });
  }
  if (expectedLt2Watts < 50 || expectedLt2Watts > 1_000) {
    warnings.push({
      code: 'EXPECTED_LT2_IMPLAUSIBLE',
      severity: 'WARNING',
      message: 'Expected LT2 is outside the default plausibility range of 50 to 1000 W',
    });
  }
  if (stageCount < 7) {
    warnings.push({
      code: 'STAGE_COUNT_TOO_SHORT',
      severity: 'WARNING',
      message: 'The plan has fewer than the recommended 7 stages',
    });
  }
  if (stageCount > 8) {
    warnings.push({
      code: 'STAGE_COUNT_TOO_LONG',
      severity: 'WARNING',
      message: 'The plan has more than the recommended 8 stages',
    });
  }
  const finalPowerWatts = startPowerWatts + (stageCount - 1) * incrementWatts;
  if (startPowerWatts <= 0 || finalPowerWatts > 2_000) {
    warnings.push({
      code: 'POWER_SEQUENCE_IMPLAUSIBLE',
      severity: 'WARNING',
      message: 'The generated power sequence falls outside the supported range',
    });
  }

  return {
    algorithmVersion: 'LT2_PLAN_V1',
    expectedLt2Watts,
    plannedLt2Watts,
    targetLt2Stage: LT2_TARGET_STAGE,
    stageCount,
    startPowerWatts,
    incrementWatts,
    powersWatts,
    warnings,
  };
}
