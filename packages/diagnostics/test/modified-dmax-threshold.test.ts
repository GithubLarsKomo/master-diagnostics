import { describe, expect, it } from 'vitest';
import { calculateModifiedDmaxThreshold } from '../src/modified-dmax-threshold';

const clinicalPoints = [
  { watts: 100, lactate: 1.0, included: true },
  { watts: 150, lactate: 1.2, included: true },
  { watts: 200, lactate: 1.7, included: true },
  { watts: 250, lactate: 2.5, included: true },
  { watts: 300, lactate: 4.2, included: true },
  { watts: 350, lactate: 7.1, included: true },
];

describe('modified Dmax threshold', () => {
  it('uses the point before the first rise greater than 0.4 mmol/l', () => {
    const result = calculateModifiedDmaxThreshold(clinicalPoints);

    expect(result.startPoint).toMatchObject({ watts: 150, lactate: 1.2 });
    expect(result.searchIntervalWatts).toEqual([150, 350]);
    expect(result.threshold.watts).toBeGreaterThanOrEqual(150);
    expect(result.threshold.watts).toBeLessThanOrEqual(350);
    expect(result.threshold.algorithm).toBe('modified-dmax-v1');
    expect(result.threshold.version).toBe('1.0.0');
    expect(Number.isFinite(result.maximumDistance)).toBe(true);
  });

  it('treats an increase of exactly 0.4 as insufficient', () => {
    const result = calculateModifiedDmaxThreshold([
      { watts: 100, lactate: 1.0, included: true },
      { watts: 150, lactate: 1.4, included: true },
      { watts: 200, lactate: 1.8, included: true },
      { watts: 250, lactate: 2.3, included: true },
      { watts: 300, lactate: 3.2, included: true },
    ]);

    expect(result.startPoint.watts).toBe(200);
  });

  it('uses only included exact points when finding the rise and endpoint', () => {
    const result = calculateModifiedDmaxThreshold([
      ...clinicalPoints,
      { watts: 125, lactate: 8, included: false },
      { watts: 400, lactate: 12, included: true, lactateQualifier: 'GREATER_THAN' as const },
    ]);

    expect(result.startPoint.watts).toBe(150);
    expect(result.searchIntervalWatts).toEqual([150, 350]);
  });

  it('fails explicitly instead of falling back when no qualifying rise exists', () => {
    expect(() => calculateModifiedDmaxThreshold([
      { watts: 100, lactate: 1.0, included: true },
      { watts: 150, lactate: 1.2, included: true },
      { watts: 200, lactate: 1.4, included: true },
      { watts: 250, lactate: 1.6, included: true },
    ])).toThrow('greater than 0.4');
  });

  it('rejects negative lactate and duplicate intensities', () => {
    expect(() => calculateModifiedDmaxThreshold([
      { watts: 100, lactate: -0.1, included: true },
      { watts: 150, lactate: 1.0, included: true },
      { watts: 200, lactate: 1.5, included: true },
      { watts: 250, lactate: 2.2, included: true },
    ])).toThrow('must not be negative');

    expect(() => calculateModifiedDmaxThreshold([
      { watts: 100, lactate: 1.0, included: true },
      { watts: 150, lactate: 1.2, included: true },
      { watts: 150, lactate: 1.8, included: true },
      { watts: 250, lactate: 2.5, included: true },
    ])).toThrow('distinct watt values');
  });
});
