export type HeartRateZone = 'ZONE_1' | 'ZONE_2' | 'ZONE_3';

export interface CreateThresholdHeartRateZonesInput {
  readonly heartRateAtLt1: number;
  readonly heartRateAtLt2: number;
  readonly measuredHeartRateMax?: number;
  readonly trainerDecisionHash: string;
  readonly warnings?: readonly string[];
}

export interface ThresholdHeartRateZones {
  readonly schemaVersion: 'threshold-heart-rate-zones-v1';
  readonly heartRateAtLt1: number;
  readonly heartRateAtLt2: number;
  readonly measuredHeartRateMax: number | null;
  readonly highestZoneUpperBound: number | null;
  readonly trainerDecisionHash: string;
  readonly warnings: readonly string[];
  classify(heartRate: number): HeartRateZone;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite integer`);
  }
  return value;
}

function normalizeWarnings(warnings: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    [...new Set((warnings ?? []).map((warning) => warning.trim()).filter(Boolean))],
  );
}

export function createThresholdHeartRateZones(
  input: CreateThresholdHeartRateZonesInput,
): ThresholdHeartRateZones {
  const heartRateAtLt1 = requirePositiveInteger(input.heartRateAtLt1, 'Heart rate at LT1');
  const heartRateAtLt2 = requirePositiveInteger(input.heartRateAtLt2, 'Heart rate at LT2');
  if (heartRateAtLt1 >= heartRateAtLt2) {
    throw new TypeError('Heart rate at LT1 must be strictly lower than heart rate at LT2');
  }

  const measuredHeartRateMax =
    input.measuredHeartRateMax === undefined
      ? null
      : requirePositiveInteger(input.measuredHeartRateMax, 'Measured heart rate max');
  if (measuredHeartRateMax !== null && measuredHeartRateMax <= heartRateAtLt2) {
    throw new TypeError('Measured heart rate max must be strictly higher than heart rate at LT2');
  }
  if (!SHA256_PATTERN.test(input.trainerDecisionHash)) {
    throw new TypeError('Trainer decision hash must be a valid SHA-256 reference');
  }

  const classify = (heartRate: number): HeartRateZone => {
    const value = requirePositiveInteger(heartRate, 'Heart rate');
    if (measuredHeartRateMax !== null && value > measuredHeartRateMax) {
      throw new RangeError('Heart rate must not exceed measured heart rate max');
    }
    if (value <= heartRateAtLt1) return 'ZONE_1';
    if (value <= heartRateAtLt2) return 'ZONE_2';
    return 'ZONE_3';
  };

  return Object.freeze({
    schemaVersion: 'threshold-heart-rate-zones-v1',
    heartRateAtLt1,
    heartRateAtLt2,
    measuredHeartRateMax,
    highestZoneUpperBound: measuredHeartRateMax,
    trainerDecisionHash: input.trainerDecisionHash,
    warnings: normalizeWarnings(input.warnings),
    classify,
  });
}
