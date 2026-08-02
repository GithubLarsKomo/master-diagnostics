import { describe, expect, it } from 'vitest';
import { classifyTestComparability } from '../src/test-comparability';

const reference = {
  deviceType: 'ROWERG',
  protocolVersionId: 'protocol-v1',
  startWatts: 180,
  incrementWatts: 30,
  maximumStages: 7,
};

describe('classifyTestComparability', () => {
  it('classifies identical protocol and plan as directly comparable', () => {
    const result = classifyTestComparability(reference, { ...reference });
    expect(result).toEqual({ classification: 'DIRECT', reasons: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it('classifies same-device protocol or plan changes as limited', () => {
    expect(classifyTestComparability(reference, {
      ...reference,
      protocolVersionId: 'protocol-v2',
      incrementWatts: 35,
    })).toEqual({
      classification: 'LIMITED',
      reasons: ['PROTOCOL_VERSION_MISMATCH', 'INCREMENT_MISMATCH'],
    });
  });

  it('classifies a device change as not comparable and preserves all reasons', () => {
    expect(classifyTestComparability(reference, {
      deviceType: 'BIKEERG',
      protocolVersionId: 'protocol-v2',
      startWatts: 200,
      incrementWatts: 25,
      maximumStages: 6,
    })).toEqual({
      classification: 'NOT_COMPARABLE',
      reasons: [
        'DEVICE_TYPE_MISMATCH',
        'PROTOCOL_VERSION_MISMATCH',
        'START_POWER_MISMATCH',
        'INCREMENT_MISMATCH',
        'STAGE_COUNT_MISMATCH',
      ],
    });
  });
});
