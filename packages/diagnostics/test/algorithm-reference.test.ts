import { describe, expect, it } from 'vitest';
import reference from '../reference/algorithm-reference-v1.json';
import {
  calculateBaselinePlusOneThreshold,
  calculateDmaxThreshold,
  calculateFixedLactateThresholds,
  fitCubicLactateRegression,
} from '../src';

const toleranceDigits = 9;

describe('algorithm reference dataset v1', () => {
  it('matches fixed and baseline-plus-one threshold references', () => {
    const fixed = calculateFixedLactateThresholds(reference.thresholdDataset.points);
    const baseline = calculateBaselinePlusOneThreshold(
      reference.thresholdDataset.points,
      reference.thresholdDataset.baselinePlusOne.baselineLactate,
    );

    expect(fixed.lt1.watts).toBeCloseTo(reference.thresholdDataset.fixed.lt1.watts, toleranceDigits);
    expect(fixed.lt1.heartRate).toBeCloseTo(reference.thresholdDataset.fixed.lt1.heartRate, toleranceDigits);
    expect(fixed.lt2.watts).toBeCloseTo(reference.thresholdDataset.fixed.lt2.watts, toleranceDigits);
    expect(fixed.lt2.heartRate).toBeCloseTo(reference.thresholdDataset.fixed.lt2.heartRate, toleranceDigits);
    expect(baseline.watts).toBeCloseTo(
      reference.thresholdDataset.baselinePlusOne.threshold.watts,
      toleranceDigits,
    );
    expect(baseline.heartRate).toBeCloseTo(
      reference.thresholdDataset.baselinePlusOne.threshold.heartRate,
      toleranceDigits,
    );
  });

  it('matches cubic regression and Dmax references', () => {
    const regression = fitCubicLactateRegression(reference.curveDataset.points);
    const dmax = calculateDmaxThreshold(reference.curveDataset.points);

    regression.coefficients.forEach((coefficient, index) => {
      expect(coefficient).toBeCloseTo(
        reference.curveDataset.regression.coefficients[index]!,
        toleranceDigits,
      );
    });
    expect(regression.wattCenter).toBeCloseTo(reference.curveDataset.regression.wattCenter, toleranceDigits);
    expect(regression.wattScale).toBeCloseTo(reference.curveDataset.regression.wattScale, toleranceDigits);
    expect(regression.rSquared).toBeCloseTo(reference.curveDataset.regression.rSquared, toleranceDigits);
    expect(regression.rmse).toBeCloseTo(reference.curveDataset.regression.rmse, toleranceDigits);
    expect(dmax.threshold.watts).toBeCloseTo(reference.curveDataset.dmax.watts, toleranceDigits);
    expect(dmax.threshold.lactate).toBeCloseTo(reference.curveDataset.dmax.lactate, toleranceDigits);
    expect(dmax.maximumDistance).toBeCloseTo(reference.curveDataset.dmax.maximumDistance, toleranceDigits);
    expect(dmax.searchIntervalWatts).toEqual(reference.curveDataset.dmax.searchIntervalWatts);
  });
});
