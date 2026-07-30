import { describe, expect, it } from 'vitest';
import { classifyStageDuration } from '../src/stage-quality';

describe('automatic stage duration quality', () => {
  it('includes a shortened stage from the configured threshold boundary', () => {
    expect(classifyStageDuration(240, 119.9, 50)).toEqual({
      actualSeconds: 119,
      qualityStatus: 'EXCLUDED',
    });
    expect(classifyStageDuration(240, 120, 50)).toEqual({
      actualSeconds: 120,
      qualityStatus: 'PARTIAL',
    });
    expect(classifyStageDuration(240, 239.9, 50)).toEqual({
      actualSeconds: 239,
      qualityStatus: 'PARTIAL',
    });
    expect(classifyStageDuration(240, 240.8, 50)).toEqual({
      actualSeconds: 240,
      qualityStatus: 'VALID',
    });
  });

  it('rejects invalid durations and thresholds', () => {
    expect(() => classifyStageDuration(0, 0, 50)).toThrow('Planned');
    expect(() => classifyStageDuration(240, -1, 50)).toThrow('Actual');
    expect(() => classifyStageDuration(240, 120, 0)).toThrow('Partial');
  });
});
