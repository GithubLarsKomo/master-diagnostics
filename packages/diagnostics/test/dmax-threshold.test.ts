import { describe, expect, it } from 'vitest';
import { calculateDmaxThreshold } from '../src/dmax-threshold';

function bowlCurve(watts: number): number {
  const x = (watts - 200) / 100;
  return 1 + x ** 2;
}

const referencePoints = [100, 150, 200, 250, 300].map((watts) => ({
  watts,
  lactate: bowlCurve(watts),
  included: true,
}));

describe('Dmax threshold', () => {
  it('finds the maximum perpendicular distance within the measured interval', () => {
    const result = calculateDmaxThreshold(referencePoints);

    expect(result.threshold.watts).toBeCloseTo(200, 8);
    expect(result.threshold.lactate).toBeCloseTo(1, 10);
    expect(result.maximumDistance).toBeCloseTo(1, 10);
    expect(result.searchIntervalWatts).toEqual([100, 300]);
    expect(result.threshold.algorithm).toBe('dmax-cubic');
    expect(result.threshold.version).toBe('1.0.0');
    expect(result.threshold.warnings).toEqual([]);
  });

  it('uses only included exact points for endpoints and regression', () => {
    const result = calculateDmaxThreshold([
      ...referencePoints,
      { watts: 50, lactate: 20, included: false },
      { watts: 350, lactate: 20, included: true, lactateQualifier: 'GREATER_THAN' as const },
    ]);

    expect(result.searchIntervalWatts).toEqual([100, 300]);
    expect(result.threshold.watts).toBeCloseTo(200, 8);
  });

  it('reports negligible separation for a straight reference sequence', () => {
    const result = calculateDmaxThreshold([100, 150, 200, 250, 300].map((watts) => ({
      watts,
      lactate: 0.01 * watts,
      included: true,
    })));

    expect(result.maximumDistance).toBeCloseTo(0, 8);
    expect(result.threshold.warnings.some((warning) => warning.startsWith('DMAX_NEGLIGIBLE_DISTANCE'))).toBe(true);
  });

  it('rejects insufficient and invalid point sets through the shared regression contract', () => {
    expect(() => calculateDmaxThreshold([
      { watts: 100, lactate: 1, included: true },
      { watts: 150, lactate: 1.2, included: true },
      { watts: 200, lactate: 1.5, included: true },
    ])).toThrow('at least four');

    expect(() => calculateDmaxThreshold([
      { watts: 100, lactate: 1, included: true },
      { watts: 150, lactate: 1.2, included: true },
      { watts: 150, lactate: 1.4, included: true },
      { watts: 200, lactate: 2, included: true },
    ])).toThrow('distinct watt values');
  });
});
