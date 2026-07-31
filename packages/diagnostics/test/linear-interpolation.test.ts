import { describe, expect, it } from 'vitest';
import { interpolateX } from '../src/linear-interpolation';

describe('linear interpolation', () => {
  it('interpolates power for a target lactate value', () => {
    expect(interpolateX(200, 350, 240, 450, 400)).toBe(220);
  });

  it('returns the exact endpoint for boundary targets', () => {
    expect(interpolateX(180, 200, 220, 400, 200)).toBe(180);
    expect(interpolateX(180, 200, 220, 400, 400)).toBe(220);
  });

  it('supports descending y values without changing the result definition', () => {
    expect(interpolateX(240, 450, 200, 350, 400)).toBe(220);
  });

  it('preserves fractional results for later model-specific rounding', () => {
    expect(interpolateX(180, 100, 220, 250, 175)).toBeCloseTo(200, 12);
    expect(interpolateX(180, 100, 220, 250, 200)).toBeCloseTo(206.6666666667, 9);
  });

  it('rejects extrapolation, flat segments and non-finite inputs', () => {
    expect(() => interpolateX(180, 200, 220, 400, 450)).toThrow('Extrapolation');
    expect(() => interpolateX(180, 200, 220, 200, 200)).toThrow('distinct y values');
    expect(() => interpolateX(180, 200, Number.NaN, 400, 300)).toThrow('finite numbers');
  });
});
