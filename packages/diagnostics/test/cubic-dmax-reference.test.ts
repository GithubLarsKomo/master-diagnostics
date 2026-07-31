import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculateDmaxThreshold } from '../src/dmax-threshold';
import {
  fitCubicLactateRegression,
  predictCubicLactate,
} from '../src/cubic-lactate-regression';

interface ReferenceDataset {
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
}

const dataset = JSON.parse(
  readFileSync(new URL('../reference/cubic-dmax-reference-v1.json', import.meta.url), 'utf8'),
) as ReferenceDataset;

function precisionFromTolerance(tolerance: number): number {
  return Math.max(0, Math.floor(-Math.log10(tolerance)));
}

describe('versioned cubic and Dmax reference dataset', () => {
  it('matches the independently generated reference values', () => {
    const precision = precisionFromTolerance(dataset.tolerance);
    const regression = fitCubicLactateRegression(dataset.points);
    const dmax = calculateDmaxThreshold(dataset.points);

    expect(regression.wattCenter).toBeCloseTo(dataset.expected.wattCenter, precision);
    expect(regression.wattScale).toBeCloseTo(dataset.expected.wattScale, precision);
    regression.coefficients.forEach((coefficient, index) => {
      expect(coefficient).toBeCloseTo(dataset.expected.coefficients[index]!, precision);
    });
    expect(regression.rSquared).toBeCloseTo(dataset.expected.rSquared, precision);
    expect(regression.rmse).toBeCloseTo(dataset.expected.rmse, precision);
    expect(predictCubicLactate(regression, dataset.expected.dmaxWatts))
      .toBeCloseTo(dataset.expected.dmaxLactate, precision);

    expect(dmax.threshold.watts).toBeCloseTo(dataset.expected.dmaxWatts, precision);
    expect(dmax.threshold.lactate).toBeCloseTo(dataset.expected.dmaxLactate, precision);
    expect(dmax.maximumDistance).toBeCloseTo(dataset.expected.maximumDistance, precision);
    expect(dmax.searchIntervalWatts).toEqual(dataset.expected.searchIntervalWatts);
  });
});
