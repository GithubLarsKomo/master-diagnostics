export type TrainingIntensityUnit = 'W' | 'BPM' | 'M_PER_S' | 'MIN_PER_500M';

export type PhysiologicalZone = 'ZONE_1' | 'ZONE_2' | 'ZONE_3';

export interface CreatePhysiologicalThreeZoneModelInput {
  readonly lt1: number;
  readonly lt2: number;
  readonly unit: TrainingIntensityUnit;
  readonly trainerDecisionHash: string;
  readonly warnings?: readonly string[];
}

export interface PhysiologicalThreeZoneModel {
  readonly schemaVersion: 'physiological-three-zone-v1';
  readonly lt1: number;
  readonly lt2: number;
  readonly unit: TrainingIntensityUnit;
  readonly trainerDecisionHash: string;
  readonly warnings: readonly string[];
  classify(intensity: number): PhysiologicalZone;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function normalizeWarnings(warnings: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...new Set((warnings ?? []).map((warning) => warning.trim()).filter(Boolean))],
  );
}

export function createPhysiologicalThreeZoneModel(
  input: CreatePhysiologicalThreeZoneModelInput,
): PhysiologicalThreeZoneModel {
  const lt1 = requirePositiveFinite(input.lt1, 'LT1');
  const lt2 = requirePositiveFinite(input.lt2, 'LT2');
  if (lt1 >= lt2) {
    throw new TypeError('LT1 must be strictly lower than LT2');
  }
  if (!SHA256_PATTERN.test(input.trainerDecisionHash)) {
    throw new TypeError('Trainer decision hash must be a valid SHA-256 reference');
  }

  const classify = (intensity: number): PhysiologicalZone => {
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new TypeError('Intensity must be a finite non-negative number');
    }
    if (intensity <= lt1) return 'ZONE_1';
    if (intensity <= lt2) return 'ZONE_2';
    return 'ZONE_3';
  };

  return Object.freeze({
    schemaVersion: 'physiological-three-zone-v1',
    lt1,
    lt2,
    unit: input.unit,
    trainerDecisionHash: input.trainerDecisionHash,
    warnings: normalizeWarnings(input.warnings),
    classify,
  });
}
