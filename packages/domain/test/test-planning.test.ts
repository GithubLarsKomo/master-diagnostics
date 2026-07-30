import { describe, expect, it } from 'vitest';
import {
  planTestFromExpectedLt2,
  roundWattsToFive,
} from '../src/test-planning';

describe('LT2 test planning', () => {
  it('reproduces the specification example for 350 W', () => {
    const plan = planTestFromExpectedLt2({ expectedLt2Watts: 350 });

    expect(plan).toMatchObject({
      algorithmVersion: 'LT2_PLAN_V1',
      plannedLt2Watts: 350,
      targetLt2Stage: 5,
      stageCount: 7,
      startPowerWatts: 210,
      incrementWatts: 35,
      powersWatts: [210, 245, 280, 315, 350, 385, 420],
      warnings: [],
    });
  });

  it('rounds to 5 W while preserving LT2 at stage 5', () => {
    const plan = planTestFromExpectedLt2({ expectedLt2Watts: 333 });

    expect(plan.plannedLt2Watts).toBe(335);
    expect(plan.powersWatts[4]).toBe(335);
    expect(plan.powersWatts.every((power) => power % 5 === 0)).toBe(true);
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      'EXPECTED_LT2_ROUNDED',
    ]);
    expect(roundWattsToFive(332.4)).toBe(330);
    expect(roundWattsToFive(332.5)).toBe(335);
  });

  it('preserves trainer overrides and warns when they move LT2 away from stage 5', () => {
    const plan = planTestFromExpectedLt2({
      expectedLt2Watts: 350,
      stageCount: 8,
      startPowerWatts: 207,
      incrementWatts: 33,
    });

    expect(plan.startPowerWatts).toBe(205);
    expect(plan.incrementWatts).toBe(35);
    expect(plan.powersWatts[4]).toBe(345);
    expect(plan.trainerOverrides).toEqual({
      stageCount: 8,
      startPowerWatts: 207,
      incrementWatts: 33,
    });
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      'START_POWER_ROUNDED',
      'INCREMENT_ROUNDED',
      'LT2_TARGET_MISMATCH',
    ]);
  });

  it.each([
    { stageCount: 6, warning: 'STAGE_COUNT_TOO_SHORT' },
    { stageCount: 9, warning: 'STAGE_COUNT_TOO_LONG' },
  ])('warns for a $stageCount-stage plan', ({ stageCount, warning }) => {
    const plan = planTestFromExpectedLt2({ expectedLt2Watts: 350, stageCount });

    expect(plan.powersWatts).toHaveLength(stageCount);
    expect(plan.warnings.map((item) => item.code)).toContain(warning);
  });

  it('returns a structured warning for an implausible but calculable LT2', () => {
    const plan = planTestFromExpectedLt2({ expectedLt2Watts: 40 });

    expect(plan.powersWatts[4]).toBe(40);
    expect(plan.warnings).toContainEqual({
      code: 'EXPECTED_LT2_IMPLAUSIBLE',
      severity: 'WARNING',
      message: 'Expected LT2 is outside the default plausibility range of 50 to 1000 W',
    });
  });

  it('rejects values that cannot form a supported plan', () => {
    expect(() => planTestFromExpectedLt2({ expectedLt2Watts: 0 })).toThrow(
      'Expected LT2 must be between 25 and 2000 watts',
    );
    expect(() => planTestFromExpectedLt2({ expectedLt2Watts: Number.NaN })).toThrow(
      'Expected LT2 must be between 25 and 2000 watts',
    );
    expect(() => planTestFromExpectedLt2({ expectedLt2Watts: 350, stageCount: 4 })).toThrow(
      'Stage count must be an integer between 5 and 12',
    );
  });

  it('is deterministic for identical input', () => {
    const input = { expectedLt2Watts: 417, stageCount: 8 };
    expect(planTestFromExpectedLt2(input)).toEqual(planTestFromExpectedLt2(input));
  });
});
