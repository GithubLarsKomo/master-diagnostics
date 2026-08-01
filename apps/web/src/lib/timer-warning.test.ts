import { describe, expect, it } from 'vitest';
import { getStageWarningThreshold } from './timer-warning';

describe('timer warning cue policy', () => {
  it('returns the latest crossed stage warning threshold', () => {
    expect(getStageWarningThreshold(31)).toBeNull();
    expect(getStageWarningThreshold(30)).toBe(30);
    expect(getStageWarningThreshold(10.5)).toBe(30);
    expect(getStageWarningThreshold(10)).toBe(10);
    expect(getStageWarningThreshold(0)).toBe(10);
  });

  it('ignores invalid countdown values', () => {
    expect(getStageWarningThreshold(-1)).toBeNull();
    expect(getStageWarningThreshold(Number.NaN)).toBeNull();
    expect(getStageWarningThreshold(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
