import { describe, expect, it } from 'vitest';
import { createThresholdFiveZoneModel } from '../src/five-zone-model';

const trainerDecisionHash = `sha256:${'b'.repeat(64)}`;

describe('threshold five-zone model', () => {
  it('derives standard boundaries and classifies each boundary deterministically', () => {
    const model = createThresholdFiveZoneModel({
      lt1: 200,
      lt2: 300,
      unit: 'W',
      trainerDecisionHash,
    });

    expect(model.boundaries).toEqual({
      zone1Upper: 170,
      zone2Upper: 200,
      zone3Upper: 285,
      zone4Upper: 306,
    });
    expect(model.classify(170)).toBe('ZONE_1');
    expect(model.classify(170.001)).toBe('ZONE_2');
    expect(model.classify(200)).toBe('ZONE_2');
    expect(model.classify(200.001)).toBe('ZONE_3');
    expect(model.classify(285)).toBe('ZONE_3');
    expect(model.classify(285.001)).toBe('ZONE_4');
    expect(model.classify(306)).toBe('ZONE_4');
    expect(model.classify(306.001)).toBe('ZONE_5');
  });

  it('preserves decimal precision and freezes nested output', () => {
    const model = createThresholdFiveZoneModel({
      lt1: 203.75,
      lt2: 287.125,
      unit: 'W',
      trainerDecisionHash,
      warnings: [' Review ', '', 'Review', 'Check LT2'],
    });

    expect(model.boundaries.zone1Upper).toBe(203.75 * 0.85);
    expect(model.boundaries.zone3Upper).toBe(287.125 * 0.95);
    expect(model.warnings).toEqual(['Review', 'Check LT2']);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.boundaries)).toBe(true);
    expect(Object.isFrozen(model.warnings)).toBe(true);
  });

  it('rejects invalid and insufficiently separated thresholds', () => {
    expect(() =>
      createThresholdFiveZoneModel({
        lt1: 200,
        lt2: 210,
        unit: 'W',
        trainerDecisionHash,
      }),
    ).toThrow('strictly increasing');

    expect(() =>
      createThresholdFiveZoneModel({
        lt1: 0,
        lt2: 300,
        unit: 'W',
        trainerDecisionHash,
      }),
    ).toThrow('positive finite');

    expect(() =>
      createThresholdFiveZoneModel({
        lt1: 200,
        lt2: 300,
        unit: 'W',
        trainerDecisionHash: 'invalid',
      }),
    ).toThrow('valid SHA-256');

    const model = createThresholdFiveZoneModel({
      lt1: 200,
      lt2: 300,
      unit: 'W',
      trainerDecisionHash,
    });
    expect(() => model.classify(-1)).toThrow('finite non-negative');
    expect(() => model.classify(Number.POSITIVE_INFINITY)).toThrow('finite non-negative');
  });
});
