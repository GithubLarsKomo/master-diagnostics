import { describe, expect, it } from 'vitest';
import referenceV1 from '../reference/algorithm-reference-v1.json';
import referenceV2 from '../reference/algorithm-reference-v2.json';
import {
  calculateBaselinePlusOneThreshold,
  calculateDmaxThreshold,
  calculateFixedLactateThresholds,
  fitCubicLactateRegression,
} from '../src';

const toleranceDigits = 9;

describe('algorithm reference dataset v1', () => {
  it('matches fixed and baseline-plus-one threshold references', () => {
    const fixed = calculateFixedLactateThresholds(referenceV1.thresholdDataset.points);
    const baseline = calculateBaselinePlusOneThreshold(
      referenceV1.thresholdDataset.points,
      referenceV1.thresholdDataset.baselinePlusOne.baselineLactate,
    );

    expect(fixed.lt1.watts).toBeCloseTo(referenceV1.thresholdDataset.fixed.lt1.watts, toleranceDigits);
    expect(fixed.lt1.heartRate).toBeCloseTo(referenceV1.thresholdDataset.fixed.lt1.heartRate, toleranceDigits);
    expect(fixed.lt2.watts).toBeCloseTo(referenceV1.thresholdDataset.fixed.lt2.watts, toleranceDigits);
    expect(fixed.lt2.heartRate).toBeCloseTo(referenceV1.thresholdDataset.fixed.lt2.heartRate, toleranceDigits);
    expect(baseline.watts).toBeCloseTo(
      referenceV1.thresholdDataset.baselinePlusOne.threshold.watts,
      toleranceDigits,
    );
    expect(baseline.heartRate).toBeCloseTo(
      referenceV1.thresholdDataset.baselinePlusOne.threshold.heartRate,
      toleranceDigits,
    );
  });

  it('matches cubic regression and Dmax references', () => {
    const regression = fitCubicLactateRegression(referenceV1.curveDataset.points);
    const dmax = calculateDmaxThreshold(referenceV1.curveDataset.points);

    regression.coefficients.forEach((coefficient, index) => {
      expect(coefficient).toBeCloseTo(
        referenceV1.curveDataset.regression.coefficients[index]!,
        toleranceDigits,
      );
    });
    expect(regression.wattCenter).toBeCloseTo(referenceV1.curveDataset.regression.wattCenter, toleranceDigits);
    expect(regression.wattScale).toBeCloseTo(referenceV1.curveDataset.regression.wattScale, toleranceDigits);
    expect(regression.rSquared).toBeCloseTo(referenceV1.curveDataset.regression.rSquared, toleranceDigits);
    expect(regression.rmse).toBeCloseTo(referenceV1.curveDataset.regression.rmse, toleranceDigits);
    expect(dmax.threshold.watts).toBeCloseTo(referenceV1.curveDataset.dmax.watts, toleranceDigits);
    expect(dmax.threshold.lactate).toBeCloseTo(referenceV1.curveDataset.dmax.lactate, toleranceDigits);
    expect(dmax.maximumDistance).toBeCloseTo(referenceV1.curveDataset.dmax.maximumDistance, toleranceDigits);
    expect(dmax.searchIntervalWatts).toEqual(referenceV1.curveDataset.dmax.searchIntervalWatts);
  });
});

describe('algorithm reference dataset v2', () => {
  it('matches a clinically plausible staged lactate sequence', () => {
    const dataset = referenceV2.realisticStageDataset;
    const fixed = calculateFixedLactateThresholds(dataset.points);
    const baseline = calculateBaselinePlusOneThreshold(
      dataset.points,
      dataset.baselinePlusOne.baselineLactate,
    );
    const regression = fitCubicLactateRegression(dataset.points);
    const dmax = calculateDmaxThreshold(dataset.points);

    expect(fixed.lt1.watts).toBeCloseTo(dataset.fixed.lt1.watts, toleranceDigits);
    expect(fixed.lt1.heartRate).toBeCloseTo(dataset.fixed.lt1.heartRate, toleranceDigits);
    expect(fixed.lt2.watts).toBeCloseTo(dataset.fixed.lt2.watts, toleranceDigits);
    expect(fixed.lt2.heartRate).toBeCloseTo(dataset.fixed.lt2.heartRate, toleranceDigits);
    expect(baseline.watts).toBeCloseTo(dataset.baselinePlusOne.threshold.watts, toleranceDigits);
    expect(baseline.heartRate).toBeCloseTo(dataset.baselinePlusOne.threshold.heartRate, toleranceDigits);

    regression.coefficients.forEach((coefficient, index) => {
      expect(coefficient).toBeCloseTo(dataset.regression.coefficients[index]!, toleranceDigits);
    });
    expect(regression.wattCenter).toBeCloseTo(dataset.regression.wattCenter, toleranceDigits);
    expect(regression.wattScale).toBeCloseTo(dataset.regression.wattScale, toleranceDigits);
    expect(regression.rSquared).toBeCloseTo(dataset.regression.rSquared, toleranceDigits);
    expect(regression.rmse).toBeCloseTo(dataset.regression.rmse, toleranceDigits);
    expect(dmax.threshold.watts).toBeCloseTo(dataset.dmax.watts, toleranceDigits);
    expect(dmax.threshold.lactate).toBeCloseTo(dataset.dmax.lactate, toleranceDigits);
    expect(dmax.maximumDistance).toBeCloseTo(dataset.dmax.maximumDistance, toleranceDigits);
    expect(dmax.searchIntervalWatts).toEqual(dataset.dmax.searchIntervalWatts);
  });

  it.each(referenceV2.problemCases)('rejects $name visibly', (problemCase) => {
    const invoke = (): unknown => {
      if (problemCase.algorithm === 'fixed') {
        return calculateFixedLactateThresholds(problemCase.points);
      }
      return fitCubicLactateRegression(problemCase.points);
    };

    expect(invoke).toThrow(problemCase.expectedError);
  });
});
