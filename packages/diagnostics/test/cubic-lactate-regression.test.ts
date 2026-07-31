import { describe, expect, it } from 'vitest';
import {
  fitCubicLactateRegression,
  predictCubicLactate,
} from '../src/cubic-lactate-regression';

function exactCubic(watts: number): number {
  const x = (watts - 220) / 60;
  return 2 + 0.9 * x + 0.4 * x ** 2 + 0.2 * x ** 3;
}

const exactPoints = [160, 180, 200, 220, 240, 260, 280].map((watts) => ({
  watts,
  lactate: exactCubic(watts),
  included: true,
}));

describe('cubic lactate regression', () => {
  it('recovers an exact cubic reference curve and predicts deterministically', () => {
    const model = fitCubicLactateRegression(exactPoints);

    expect(model.algorithm).toBe('cubic-lactate-least-squares');
    expect(model.version).toBe('1.0.0');
    expect(model.pointCount).toBe(7);
    expect(model.rSquared).toBeCloseTo(1, 12);
    expect(model.rmse).toBeCloseTo(0, 12);
    expect(model.warnings).toEqual([]);
    expect(predictCubicLactate(model, 230)).toBeCloseTo(exactCubic(230), 12);
  });

  it('reports reproducible model quality for a noisy reference dataset', () => {
    const noisy = exactPoints.map((point, index) => ({
      ...point,
      lactate: point.lactate + [0.08, -0.06, 0.03, -0.04, 0.07, -0.02, 0.05][index]!,
    }));
    const model = fitCubicLactateRegression(noisy);

    expect(model.rSquared).toBeGreaterThan(0.99);
    expect(model.rmse).toBeGreaterThan(0);
    expect(model.rmse).toBeLessThan(0.1);
  });

  it('ignores excluded and censored points', () => {
    const model = fitCubicLactateRegression([
      ...exactPoints,
      { watts: 170, lactate: 20, included: false },
      { watts: 190, lactate: 20, lactateQualifier: 'LESS_THAN' as const, included: true },
    ]);

    expect(model.pointCount).toBe(7);
    expect(model.rSquared).toBeCloseTo(1, 12);
  });

  it('emits a visible warning for a poor cubic fit', () => {
    const model = fitCubicLactateRegression([
      { watts: 100, lactate: 1, included: true },
      { watts: 120, lactate: 4, included: true },
      { watts: 140, lactate: 1, included: true },
      { watts: 160, lactate: 4, included: true },
      { watts: 180, lactate: 1, included: true },
      { watts: 200, lactate: 4, included: true },
    ]);

    expect(model.rSquared).toBeLessThan(0.95);
    expect(model.warnings).toEqual([
      expect.stringContaining('LOW_R_SQUARED'),
    ]);
  });

  it('rejects insufficient, duplicate and non-finite input data', () => {
    expect(() => fitCubicLactateRegression(exactPoints.slice(0, 3))).toThrow('At least four');
    expect(() => fitCubicLactateRegression([
      ...exactPoints.slice(0, 4),
      { watts: 220, lactate: 3, included: true },
    ])).toThrow('distinct watt values');
    expect(() => fitCubicLactateRegression([
      ...exactPoints.slice(0, 3),
      { watts: Number.NaN, lactate: 3, included: true },
    ])).toThrow('finite watts and lactate');
    expect(() => predictCubicLactate({
      coefficients: [1, 2, 3, 4], wattCenter: 200, wattScale: 0,
    }, 220)).toThrow('wattScale must be positive');
  });
});
