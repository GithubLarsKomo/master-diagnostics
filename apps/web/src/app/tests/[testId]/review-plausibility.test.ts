import { describe, expect, it } from 'vitest';
import type { TestReviewRow } from '@masters/db';
import { getReviewPlausibilityWarnings } from './review-plausibility';

function stage(
  stageNumber: number,
  lactateValueX100: number,
  heartRate: number,
): TestReviewRow {
  return {
    kind: 'STAGE',
    stageNumber,
    entityId: `stage-${stageNumber}`,
    targetWatts: 100 + stageNumber * 20,
    plannedSeconds: 240,
    actualSeconds: 240,
    heartRate,
    lactateValueX100,
    lactateQualifier: 'EXACT',
    measuredAt: '2026-07-30T20:00:00.000Z',
    qualityStatus: 'VALID',
    notes: null,
    version: 1,
  };
}

describe('DATA_REVIEW plausibility integration', () => {
  it('returns deterministic warnings for review rows', () => {
    const warnings = getReviewPlausibilityWarnings([
      stage(1, 240, 160),
      stage(2, 170, 148),
    ]);

    expect(warnings.map((warning) => warning.code)).toEqual([
      'LACTATE_DROP',
      'HEART_RATE_DROP',
    ]);
  });

  it('keeps an ordinary measurement sequence warning-free', () => {
    expect(getReviewPlausibilityWarnings([
      stage(1, 120, 140),
      stage(2, 180, 150),
    ])).toEqual([]);
  });
});
