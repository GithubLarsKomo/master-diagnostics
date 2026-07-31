import { describe, expect, it } from 'vitest';
import datasetJson from '../reference/asymmetric-dmax-reference-v1.json';
import { calculateDmaxThreshold } from '../src/dmax-threshold';
import { fitCubicLactateRegression } from '../src/cubic-lactate-regression';

const dataset = datasetJson as unknown as {
  points: Array<{ watts: number; lactate: number; included: boolean }>;
  expected: {
    wattCenter: number;
    wattScale: number;
    coefficients: [number, number, number, number];
    rSquared: number;
    rmse: number;
    dmaxWatts: number;
    dmaxLactate: number;
    maximumDistance: number;
    searchIntervalWatts: [number, number];
  };
  tolerance: number;
};

function precision(tolerance: number): number {
  return Math.max(0, Math.floor(-Math.log10(tolerance)));
}

describe('asymmetric cubic and Dmax reference dataset', () => {
  it('matches independently calculated regression and Dmax values', () => {
    const digits = precision(dataset.tolerance);
    const regression = fitCubicLactateRegression(dataset.points);
    const dmax = calculateDmaxThreshold(dataset.points);

    expect(regression.wattCenter).toBeCloseTo(dataset.expected.wattCenter, digits);
    expect(regression.wattScale).toBeCloseTo(dataset.expected.wattScale, digits);
    regression.coefficients.forEach((value, index) => {
      expect(value).toBeCloseTo(dataset.expected.coefficients[index]!, digits);
    });
    expect(regression.rSquared).toBeCloseTo(dataset.expected.rSquared, digits);
    expect(regression.rmse).toBeCloseTo(dataset.expected.rmse, digits);
    expect(dmax.threshold.watts).toBeCloseTo(dataset.expected.dmaxWatts, digits);
    expect(dmax.threshold.lactate).toBeCloseTo(dataset.expected.dmaxLactate, digits);
    expect(dmax.maximumDistance).toBeCloseTo(dataset.expected.maximumDistance, digits);
    expect(dmax.searchIntervalWatts).toEqual(dataset.expected.searchIntervalWatts);
  });
});
