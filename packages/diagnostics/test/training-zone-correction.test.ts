import { describe, expect, it } from 'vitest';
import { createTrainingZoneCorrection } from '../src/training-zone-correction';

const sourceModelHash = `sha256:${'d'.repeat(64)}` as const;

const baseInput = {
  correctionId: 'correction-1',
  modelKind: 'THRESHOLD_FIVE_ZONE' as const,
  sourceModelHash,
  version: 1,
  boundaries: [170, 200, 285, 306],
  unit: 'W',
  reason: ' Individualisierte Trainingssteuerung ',
  trainerId: 'trainer-1',
  createdAt: '2026-08-01T04:00:00.000Z',
};

describe('training-zone-correction-v1', () => {
  it('creates deterministic immutable versioned corrections', async () => {
    const first = await createTrainingZoneCorrection(baseInput);
    const repeated = await createTrainingZoneCorrection(baseInput);
    expect(first.correctionHash).toBe(repeated.correctionHash);
    expect(first.reason).toBe('Individualisierte Trainingssteuerung');
    expect(first.previousCorrectionHash).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.boundaries)).toBe(true);

    const second = await createTrainingZoneCorrection({
      ...baseInput,
      correctionId: 'correction-2',
      version: 2,
      previousCorrection: first,
      boundaries: [168, 198, 282, 304],
      createdAt: '2026-08-01T05:00:00.000Z',
    });
    expect(second.previousCorrectionHash).toBe(first.correctionHash);
  });

  it('supports an open upper heart-rate boundary', async () => {
    const correction = await createTrainingZoneCorrection({
      ...baseInput,
      modelKind: 'THRESHOLD_HEART_RATE_ZONES',
      boundaries: [145, 165, null],
      unit: 'BPM',
    });
    expect(correction.boundaries).toEqual([145, 165, null]);
  });

  it('rejects broken chains and invalid boundaries', async () => {
    await expect(
      createTrainingZoneCorrection({ ...baseInput, version: 2 }),
    ).rejects.toThrow('require the previous correction');

    await expect(
      createTrainingZoneCorrection({ ...baseInput, boundaries: [200, 170] }),
    ).rejects.toThrow('strictly increasing');

    await expect(
      createTrainingZoneCorrection({
        ...baseInput,
        modelKind: 'THRESHOLD_HEART_RATE_ZONES',
        boundaries: [145.5, 165, null],
      }),
    ).rejects.toThrow('must be integers');
  });
});
