import { describe, expect, it } from 'vitest';
import { createPhysiologicalThreeZoneModel } from '../src/three-zone-model';

const trainerDecisionHash = `sha256:${'a'.repeat(64)}`;

describe('physiological three-zone model', () => {
  it('classifies LT1 and LT2 boundaries deterministically', () => {
    const model = createPhysiologicalThreeZoneModel({
      lt1: 200,
      lt2: 300,
      unit: 'W',
      trainerDecisionHash,
    });

    expect(model.classify(0)).toBe('ZONE_1');
    expect(model.classify(200)).toBe('ZONE_1');
    expect(model.classify(200.001)).toBe('ZONE_2');
    expect(model.classify(300)).toBe('ZONE_2');
    expect(model.classify(300.001)).toBe('ZONE_3');
  });

  it('preserves exact thresholds and normalizes warnings', () => {
    const model = createPhysiologicalThreeZoneModel({
      lt1: 203.75,
      lt2: 287.125,
      unit: 'W',
      trainerDecisionHash,
      warnings: [' Review LT1 ', '', 'Review LT1', 'Review LT2'],
    });

    expect(model.lt1).toBe(203.75);
    expect(model.lt2).toBe(287.125);
    expect(model.warnings).toEqual(['Review LT1', 'Review LT2']);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.warnings)).toBe(true);
  });

  it('rejects invalid thresholds, hashes and intensities', () => {
    expect(() =>
      createPhysiologicalThreeZoneModel({
        lt1: 300,
        lt2: 300,
        unit: 'W',
        trainerDecisionHash,
      }),
    ).toThrow('strictly lower');

    expect(() =>
      createPhysiologicalThreeZoneModel({
        lt1: -1,
        lt2: 300,
        unit: 'W',
        trainerDecisionHash,
      }),
    ).toThrow('positive finite');

    expect(() =>
      createPhysiologicalThreeZoneModel({
        lt1: 200,
        lt2: 300,
        unit: 'W',
        trainerDecisionHash: 'invalid',
      }),
    ).toThrow('valid SHA-256');

    const model = createPhysiologicalThreeZoneModel({
      lt1: 200,
      lt2: 300,
      unit: 'W',
      trainerDecisionHash,
    });
    expect(() => model.classify(Number.NaN)).toThrow('finite non-negative');
    expect(() => model.classify(-1)).toThrow('finite non-negative');
  });
});
