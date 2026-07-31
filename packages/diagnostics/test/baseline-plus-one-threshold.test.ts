import { describe, expect, it } from 'vitest';
import { calculateBaselinePlusOneThreshold } from '../src/baseline-plus-one-threshold';

const points = [
  { watts: 160, lactate: 1.2, heartRate: 130, included: true },
  { watts: 200, lactate: 2.4, heartRate: 145, included: true },
  { watts: 240, lactate: 3.6, heartRate: 160, included: true },
  { watts: 280, lactate: 5.2, heartRate: 174, included: true },
] as const;

describe('baseline plus one mmol threshold', () => {
  it('interpolates the target derived from an explicit baseline', () => {
    const result = calculateBaselinePlusOneThreshold(points, 1.1);

    expect(result.watts).toBeCloseTo(190, 12);
    expect(result.lactate).toBeCloseTo(2.1, 12);
    expect(result.heartRate).toBeCloseTo(141.25, 12);
    expect(result.algorithm).toBe('baseline-plus-one-mmol');
    expect(result.version).toBe('1.0.0');
    expect(result.warnings).toEqual([]);
  });

  it('uses an exact included target point without interpolation', () => {
    const result = calculateBaselinePlusOneThreshold([
      { watts: 180, lactate: 1.2, included: true },
      { watts: 220, lactate: 2.2, heartRate: 150, included: true },
      { watts: 260, lactate: 4.5, included: true },
    ], 1.2);

    expect(result).toMatchObject({ watts: 220, lactate: 2.2, heartRate: 150 });
  });

  it('ignores excluded and censored points', () => {
    const result = calculateBaselinePlusOneThreshold([
      ...points,
      { watts: 180, lactate: 2.1, included: false },
      { watts: 190, lactate: 2.1, lactateQualifier: 'LESS_THAN' as const, included: true },
    ], 1.1);

    expect(result.watts).toBeCloseTo(190, 12);
  });

  it('rejects invalid baselines and missing brackets instead of extrapolating', () => {
    expect(() => calculateBaselinePlusOneThreshold(points, Number.NaN)).toThrow('finite non-negative');
    expect(() => calculateBaselinePlusOneThreshold(points, -0.1)).toThrow('finite non-negative');
    expect(() => calculateBaselinePlusOneThreshold([
      { watts: 180, lactate: 1, included: true },
      { watts: 220, lactate: 2, included: true },
    ], 2)).toThrow('No included exact points bracket baseline + 1 mmol/L');
  });

  it('rejects ambiguous crossings and duplicate watt stages', () => {
    expect(() => calculateBaselinePlusOneThreshold([
      { watts: 180, lactate: 1, included: true },
      { watts: 200, lactate: 3, included: true },
      { watts: 220, lactate: 1.5, included: true },
      { watts: 240, lactate: 3, included: true },
    ], 1)).toThrow('Multiple intervals bracket baseline + 1 mmol/L');

    expect(() => calculateBaselinePlusOneThreshold([
      { watts: 180, lactate: 1, included: true },
      { watts: 180, lactate: 3, included: true },
    ], 1)).toThrow('distinct watt values');
  });
});
