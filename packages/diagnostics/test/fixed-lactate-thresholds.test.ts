import { describe, expect, it } from 'vitest';
import { calculateFixedLactateThresholds } from '../src/fixed-lactate-thresholds';

const points = [
  { watts: 160, lactate: 1.2, heartRate: 130, included: true },
  { watts: 200, lactate: 2.4, heartRate: 145, included: true },
  { watts: 240, lactate: 3.6, heartRate: 160, included: true },
  { watts: 280, lactate: 5.2, heartRate: 174, included: true },
] as const;

describe('fixed 2/4 mmol thresholds', () => {
  it('interpolates LT1 and LT2 including heart rate', () => {
    const result = calculateFixedLactateThresholds(points);

    expect(result.lt1).toMatchObject({
      lactate: 2,
      heartRate: 140,
      algorithm: 'fixed-lactate-2-4-mmol',
      version: '1.0.0',
      warnings: [],
    });
    expect(result.lt1.watts).toBeCloseTo(186.6666666667, 9);
    expect(result.lt2.watts).toBe(250);
    expect(result.lt2.heartRate).toBeCloseTo(163.5, 12);
  });

  it('uses an exact target point without interpolation', () => {
    const result = calculateFixedLactateThresholds([
      { watts: 180, lactate: 1, included: true },
      { watts: 210, lactate: 2, included: true },
      { watts: 250, lactate: 4, included: true },
    ]);

    expect(result.lt1.watts).toBe(210);
    expect(result.lt2.watts).toBe(250);
  });

  it('ignores excluded and censored points', () => {
    const result = calculateFixedLactateThresholds([
      ...points,
      { watts: 180, lactate: 2, included: false },
      { watts: 220, lactate: 4, lactateQualifier: 'LESS_THAN' as const, included: true },
    ]);

    expect(result.lt1.watts).toBeCloseTo(186.6666666667, 9);
    expect(result.lt2.watts).toBe(250);
  });

  it('rejects missing brackets instead of extrapolating', () => {
    expect(() => calculateFixedLactateThresholds([
      { watts: 180, lactate: 1, included: true },
      { watts: 220, lactate: 3, included: true },
    ])).toThrow('No included exact points bracket 4 mmol/L');
  });

  it('rejects ambiguous crossings and duplicate watt stages', () => {
    expect(() => calculateFixedLactateThresholds([
      { watts: 180, lactate: 1, included: true },
      { watts: 200, lactate: 3, included: true },
      { watts: 220, lactate: 1.5, included: true },
      { watts: 240, lactate: 3, included: true },
      { watts: 260, lactate: 5, included: true },
    ])).toThrow('Multiple intervals bracket 2 mmol/L');

    expect(() => calculateFixedLactateThresholds([
      { watts: 180, lactate: 1, included: true },
      { watts: 180, lactate: 3, included: true },
      { watts: 220, lactate: 5, included: true },
    ])).toThrow('distinct watt values');
  });
});
