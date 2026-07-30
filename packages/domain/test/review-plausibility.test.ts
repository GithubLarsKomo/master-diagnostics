import { describe, expect, it } from 'vitest';
import {
  evaluateReviewPlausibility,
  type ReviewPlausibilityStage,
} from '../src/review-plausibility';

function stage(
  stageNumber: number,
  overrides: Partial<ReviewPlausibilityStage> = {},
): ReviewPlausibilityStage {
  return {
    stageNumber,
    targetWatts: 150 + stageNumber * 30,
    plannedSeconds: 240,
    actualSeconds: 240,
    heartRate: 120 + stageNumber * 10,
    lactateValueX100: 100 + stageNumber * 50,
    lactateQualifier: 'EXACT',
    qualityStatus: 'VALID',
    ...overrides,
  };
}

describe('data-review plausibility warnings', () => {
  it('detects deterministic sequence, missing-value and duration warnings', () => {
    const warnings = evaluateReviewPlausibility({
      restLactateValueX100: 180,
      restLactateQualifier: 'EXACT',
      stages: [
        stage(1, { lactateValueX100: 160, heartRate: 130 }),
        stage(2, {
          lactateValueX100: null,
          lactateQualifier: null,
          heartRate: 125,
        }),
        stage(3, {
          lactateValueX100: 150,
          actualSeconds: 120,
          qualityStatus: 'PARTIAL',
        }),
      ],
    });

    expect(warnings.map((warning) => warning.code)).toEqual([
      'LACTATE_DECREASE',
      'INTERNAL_MISSING_LACTATE',
      'HEART_RATE_DECREASE',
      'REST_ABOVE_FIRST_STAGE',
      'SHORTENED_STAGE',
      'LIMITED_EXACT_DATA_BASIS',
    ]);
    expect(warnings.find((warning) => warning.code === 'SHORTENED_STAGE'))
      .toMatchObject({ stageNumbers: [3] });
  });

  it('groups identical values and flags qualified measurements', () => {
    const warnings = evaluateReviewPlausibility({
      restLactateValueX100: 90,
      restLactateQualifier: 'LESS_THAN',
      stages: [
        stage(1, { lactateValueX100: 150 }),
        stage(2, { lactateValueX100: 150 }),
        stage(3, { lactateValueX100: 150 }),
        stage(4, {
          lactateValueX100: 200,
          lactateQualifier: 'GREATER_THAN',
        }),
      ],
    });

    expect(warnings.filter(
      (warning) => warning.code === 'IDENTICAL_LACTATE_SERIES',
    )).toEqual([expect.objectContaining({ stageNumbers: [1, 2, 3] })]);
    expect(warnings.filter(
      (warning) => warning.code === 'QUALIFIED_LACTATE',
    )).toHaveLength(2);
  });

  it('ignores excluded stages in cross-stage comparisons', () => {
    const warnings = evaluateReviewPlausibility({
      restLactateValueX100: null,
      restLactateQualifier: null,
      stages: [
        stage(1, { lactateValueX100: 200, heartRate: 150 }),
        stage(2, {
          lactateValueX100: 100,
          heartRate: 100,
          qualityStatus: 'EXCLUDED',
        }),
        stage(3, { lactateValueX100: 250, heartRate: 160 }),
        stage(4, { lactateValueX100: 300, heartRate: 170 }),
        stage(5, { lactateValueX100: 350, heartRate: 180 }),
      ],
    });

    expect(warnings).toEqual([]);
  });
});
