import { describe, expect, it } from 'vitest';
import { fitCubicLactateRegression } from '../src/cubic-regression';

function exactCurve(watts: number): number {
  const x = (watts - 220) / 80;
  return 1.2 + 0.8 * x + 0.6 * x ** 2 + 0.4 * x ** 3;
}

describe('cubic lactate regression', () => {
  it('recovers a known cubic curve and reports perfect fit', () => {
    const points = [140, 180, 220, 260, 300].map((watts) => ({
      watts,
      lactate: exactCurve(watts),
      included: true,
    }));

    const model = fitCubicLactateRegression(points);

    expect(model.predictLactate(240)).toBeCloseTo(exactCurve(240), 10);
    expect(model.quality.rSquared).toBeCloseTo(1, 12);
    expect(model.quality.rmse).toBeCloseTo(0, 12);
    expect(model.quality.pointCount).toBe(5);
    expect(model.algorithm).toBe('cubic-lactate-regression');
    expect(model.version).toBe('1.0.0');
    expect(model.warnings).toEqual([]);
  });

  it('ignores excluded and censored points', () => {
    const model = fitCubicLactateRegression([
      ...[140, 180, 220, 260, 300].map((watts) => ({
        watts,
        lactate: exactCurve(watts),
        included: true,
      })),
      { watts: 160, lactate: 99, included: false },
      { watts: 200, lactate: 99, included: true, lactateQualifier: 'LESS_THAN' as const },
    ]);

    expect(model.predictLactate(240)).toBeCloseTo(exactCurve(240), 10);
    expect(model.quality.pointCount).toBe(5);
  });

  it('warns when exactly four points determine the cubic', () => {
    const model = fitCubicLactateRegression([140, 180, 220, 260].map((watts) => ({
      watts,
      lactate: exactCurve(watts),
      included: true,
    })));

    expect(model.warnings).toContain('EXACT_FOUR_POINT_FIT');
  });

  it('reports low model quality for a poorly fitting sequence', () => {
    const model = fitCubicLactateRegression([
      { watts: 100, lactate: 1, included: true },
      { watts: 120, lactate: 5, included: true },
      { watts: 140, lactate: 1, included: true },
      { watts: 160, lactate: 5, included: true },
      { watts: 180, lactate: 1, included: true },
      { watts: 200, lactate: 5, included: true },
      { watts: 220, lactate: 1, included: true },
      { watts: 240, lactate: 5, included: true },
    ]);

    expect(model.quality.rSquared).toBeLessThan(0.9);
    expect(model.warnings).toContain('LOW_R_SQUARED');
  });

  it('rejects insufficient, duplicate and non-finite points', () => {
    expect(() => fitCubicLactateRegression([
      { watts: 100, lactate: 1, included: true },
      { watts: 120, lactate: 2, included: true },
      { watts: 140, lactate: 3, included: true },
    ])).toThrow('at least four');

    expect(() => fitCubicLactateRegression([
      { watts: 100, lactate: 1, included: true },
      { watts: 100, lactate: 2, included: true },
      { watts: 140, lactate: 3, included: true },
      { watts: 160, lactate: 4, included: true },
    ])).toThrow('distinct watt values');

    expect(() => fitCubicLactateRegression([
      { watts: 100, lactate: 1, included: true },
      { watts: 120, lactate: 2, included: true },
      { watts: 140, lactate: Number.NaN, included: true },
      { watts: 160, lactate: 4, included: true },
    ])).toThrow('finite watts and lactate');
  });
});
