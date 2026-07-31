import { describe, expect, it } from 'vitest';
import { fitCubicLactateRegression } from '../src/cubic-regression';

function cubic(watts: number): number {
  const x = (watts - 220) / 60;
  return 2 + 0.8 * x + 0.5 * x * x + 0.2 * x * x * x;
}

describe('cubic lactate regression', () => {
  it('recovers an exact cubic reference curve', () => {
    const points = [160, 180, 200, 220, 240, 260, 280].map((watts) => ({
      watts,
      lactate: cubic(watts),
      included: true,
    }));
    const model = fitCubicLactateRegression(points);

    expect(model.predictLactate(230)).toBeCloseTo(cubic(230), 12);
    expect(model.rSquared).toBeCloseTo(1, 12);
    expect(model.rmse).toBeCloseTo(0, 12);
    expect(model.pointCount).toBe(7);
    expect(model.warnings).toEqual([]);
  });

  it('reports model fit for a noisy reference dataset', () => {
    const offsets = [0.04, -0.03, 0.02, -0.01, 0.03, -0.02, 0.01];
    const points = [160, 180, 200, 220, 240, 260, 280].map((watts, index) => ({
      watts,
      lactate: cubic(watts) + offsets[index]!,
      included: true,
    }));
    const model = fitCubicLactateRegression(points);

    expect(model.rSquared).toBeGreaterThan(0.99);
    expect(model.rmse).toBeGreaterThan(0);
    expect(model.algorithm).toBe('cubic-lactate-regression');
    expect(model.version).toBe('1.0.0');
  });

  it('ignores excluded and censored points', () => {
    const model = fitCubicLactateRegression([
      ...[160, 200, 240, 280].map((watts) => ({ watts, lactate: cubic(watts), included: true })),
      { watts: 180, lactate: 99, included: false },
      { watts: 220, lactate: 99, lactateQualifier: 'LESS_THAN' as const, included: true },
    ]);

    expect(model.pointCount).toBe(4);
    expect(model.predictLactate(220)).toBeCloseTo(cubic(220), 10);
  });

  it('rejects insufficient, duplicate and invalid input', () => {
    expect(() => fitCubicLactateRegression([
      { watts: 160, lactate: 1, included: true },
      { watts: 200, lactate: 2, included: true },
      { watts: 240, lactate: 3, included: true },
    ])).toThrow('At least four');

    expect(() => fitCubicLactateRegression([
      { watts: 160, lactate: 1, included: true },
      { watts: 160, lactate: 2, included: true },
      { watts: 240, lactate: 3, included: true },
      { watts: 280, lactate: 4, included: true },
    ])).toThrow('distinct watt values');

    expect(() => fitCubicLactateRegression([
      { watts: 160, lactate: 1, included: true },
      { watts: 200, lactate: 2, included: true },
      { watts: 240, lactate: Number.NaN, included: true },
      { watts: 280, lactate: 4, included: true },
    ])).toThrow('finite watts and lactate');
  });

  it('rejects non-finite prediction inputs', () => {
    const model = fitCubicLactateRegression(
      [160, 200, 240, 280].map((watts) => ({ watts, lactate: cubic(watts), included: true })),
    );
    expect(() => model.predictLactate(Number.POSITIVE_INFINITY)).toThrow('finite');
  });
});
