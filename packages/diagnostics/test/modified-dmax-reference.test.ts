import { describe, expect, it } from 'vitest';
import datasetJson from '../reference/modified-dmax-reference-v1.json';
import { calculateModifiedDmaxThreshold } from '../src/modified-dmax-threshold';

const dataset = datasetJson as unknown as {
  points: Array<{ watts: number; lactate: number; included: boolean }>;
  expected: {
    coefficients: [number, number, number, number];
    wattCenter: number;
    wattScale: number;
    rSquared: number;
    rmse: number;
    startPoint: { watts: number; lactate: number; included: boolean };
    watts: number;
    lactate: number;
    maximumDistance: number;
    searchIntervalWatts: [number, number];
  };
  tolerance: number;
};

function precision(tolerance: number): number {
  return Math.max(0, Math.floor(-Math.log10(tolerance)));
}

describe('modified Dmax independent reference dataset', () => {
  it('matches the Python regression, start point and distance maximum', () => {
    const digits = precision(dataset.tolerance);
    const result = calculateModifiedDmaxThreshold(dataset.points);

    expect(result.regression.wattCenter).toBeCloseTo(dataset.expected.wattCenter, digits);
    expect(result.regression.wattScale).toBeCloseTo(dataset.expected.wattScale, digits);
    result.regression.coefficients.forEach((value, index) => {
      expect(value).toBeCloseTo(dataset.expected.coefficients[index]!, digits);
    });
    expect(result.regression.rSquared).toBeCloseTo(dataset.expected.rSquared, digits);
    expect(result.regression.rmse).toBeCloseTo(dataset.expected.rmse, digits);
    expect(result.startPoint).toEqual(dataset.expected.startPoint);
    expect(result.threshold.watts).toBeCloseTo(dataset.expected.watts, digits);
    expect(result.threshold.lactate).toBeCloseTo(dataset.expected.lactate, digits);
    expect(result.maximumDistance).toBeCloseTo(dataset.expected.maximumDistance, digits);
    expect(result.searchIntervalWatts).toEqual(dataset.expected.searchIntervalWatts);
    expect(result.threshold.algorithm).toBe('modified-dmax-v1');
    expect(result.threshold.version).toBe('1.0.0');
  });
});
