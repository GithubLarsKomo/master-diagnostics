import type { TrainingIntensityUnit } from './three-zone-model';

export type ThresholdTrainingZone = 'ZONE_1' | 'ZONE_2' | 'ZONE_3' | 'ZONE_4' | 'ZONE_5';

export interface CreateThresholdFiveZoneModelInput {
  readonly lt1: number;
  readonly lt2: number;
  readonly unit: TrainingIntensityUnit;
  readonly trainerDecisionHash: string;
  readonly warnings?: readonly string[];
}

export interface ThresholdFiveZoneBoundaries {
  readonly zone1Upper: number;
  readonly zone2Upper: number;
  readonly zone3Upper: number;
  readonly zone4Upper: number;
}

export interface ThresholdFiveZoneModel {
  readonly schemaVersion: 'threshold-five-zone-v1';
  readonly lt1: number;
  readonly lt2: number;
  readonly unit: TrainingIntensityUnit;
  readonly trainerDecisionHash: string;
  readonly boundaries: ThresholdFiveZoneBoundaries;
  readonly warnings: readonly string[];
  classify(intensity: number): ThresholdTrainingZone;
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

export function createThresholdFiveZoneModel(
  input: CreateThresholdFiveZoneModelInput,
): ThresholdFiveZoneModel {
  const lt1 = requirePositiveFinite(input.lt1, 'LT1');
  const lt2 = requirePositiveFinite(input.lt2, 'LT2');
  if (lt1 >= lt2) {
    throw new TypeError('LT1 must be strictly lower than LT2');
  }
  if (!SHA256_PATTERN.test(input.trainerDecisionHash)) {
    throw new TypeError('Trainer decision hash must be a valid SHA-256 reference');
  }

  const boundaries = Object.freeze({
    zone1Upper: lt1 * 0.85,
    zone2Upper: lt1,
    zone3Upper: lt2 * 0.95,
    zone4Upper: lt2 * 1.02,
  });

  if (
    !(
      boundaries.zone1Upper < boundaries.zone2Upper &&
      boundaries.zone2Upper < boundaries.zone3Upper &&
      boundaries.zone3Upper < boundaries.zone4Upper
    )
  ) {
    throw new TypeError('Derived five-zone boundaries must be strictly increasing');
  }

  const classify = (intensity: number): ThresholdTrainingZone => {
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new TypeError('Intensity must be a finite non-negative number');
    }
    if (intensity <= boundaries.zone1Upper) return 'ZONE_1';
    if (intensity <= boundaries.zone2Upper) return 'ZONE_2';
    if (intensity <= boundaries.zone3Upper) return 'ZONE_3';
    if (intensity <= boundaries.zone4Upper) return 'ZONE_4';
    return 'ZONE_5';
  };

  return Object.freeze({
    schemaVersion: 'threshold-five-zone-v1',
    lt1,
    lt2,
    unit: input.unit,
    trainerDecisionHash: input.trainerDecisionHash,
    boundaries,
    warnings: normalizeWarnings(input.warnings),
    classify,
  });
}
