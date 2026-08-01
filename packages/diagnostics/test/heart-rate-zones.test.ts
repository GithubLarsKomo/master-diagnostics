import { describe, expect, it } from 'vitest';
import { createThresholdHeartRateZones } from '../src/heart-rate-zones';

const trainerDecisionHash = `sha256:${'c'.repeat(64)}`;

describe('threshold heart-rate zones', () => {
  it('classifies LT1 and LT2 boundaries with an open highest zone', () => {
    const zones = createThresholdHeartRateZones({
      heartRateAtLt1: 145,
      heartRateAtLt2: 165,
      trainerDecisionHash,
    });

    expect(zones.highestZoneUpperBound).toBeNull();
    expect(zones.measuredHeartRateMax).toBeNull();
    expect(zones.classify(145)).toBe('ZONE_1');
    expect(zones.classify(146)).toBe('ZONE_2');
    expect(zones.classify(165)).toBe('ZONE_2');
    expect(zones.classify(166)).toBe('ZONE_3');
    expect(zones.classify(220)).toBe('ZONE_3');
  });

  it('uses a measured heart-rate maximum as the highest-zone upper bound', () => {
    const zones = createThresholdHeartRateZones({
      heartRateAtLt1: 145,
      heartRateAtLt2: 165,
      measuredHeartRateMax: 182,
      trainerDecisionHash,
      warnings: [' Verify HFmax ', '', 'Verify HFmax'],
    });

    expect(zones.highestZoneUpperBound).toBe(182);
    expect(zones.classify(182)).toBe('ZONE_3');
    expect(() => zones.classify(183)).toThrow('must not exceed');
    expect(zones.warnings).toEqual(['Verify HFmax']);
    expect(Object.isFrozen(zones)).toBe(true);
    expect(Object.isFrozen(zones.warnings)).toBe(true);
  });

  it('rejects invalid ordering, non-integer BPM values and invalid hashes', () => {
    expect(() =>
      createThresholdHeartRateZones({
        heartRateAtLt1: 165,
        heartRateAtLt2: 165,
        trainerDecisionHash,
      }),
    ).toThrow('strictly lower');

    expect(() =>
      createThresholdHeartRateZones({
        heartRateAtLt1: 145.5,
        heartRateAtLt2: 165,
        trainerDecisionHash,
      }),
    ).toThrow('positive finite integer');

    expect(() =>
      createThresholdHeartRateZones({
        heartRateAtLt1: 145,
        heartRateAtLt2: 165,
        measuredHeartRateMax: 160,
        trainerDecisionHash,
      }),
    ).toThrow('strictly higher');

    expect(() =>
      createThresholdHeartRateZones({
        heartRateAtLt1: 145,
        heartRateAtLt2: 165,
        trainerDecisionHash: 'invalid',
      }),
    ).toThrow('valid SHA-256');
  });
});
