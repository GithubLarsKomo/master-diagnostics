import { createDiagnosticResultHash, type DiagnosticResultHash } from './result-hash';

export type TrainingZoneModelKind =
  | 'PHYSIOLOGICAL_THREE_ZONE'
  | 'THRESHOLD_FIVE_ZONE'
  | 'THRESHOLD_HEART_RATE_ZONES';

export interface TrainingZoneCorrectionInput {
  readonly correctionId: string;
  readonly modelKind: TrainingZoneModelKind;
  readonly sourceModelHash: DiagnosticResultHash;
  readonly version: number;
  readonly previousCorrection?: TrainingZoneCorrection | null;
  readonly boundaries: readonly (number | null)[];
  readonly unit: string;
  readonly reason: string;
  readonly trainerId: string;
  readonly createdAt: string;
  readonly warnings?: readonly string[];
}

export interface TrainingZoneCorrection {
  readonly schemaVersion: 'training-zone-correction-v1';
  readonly correctionId: string;
  readonly modelKind: TrainingZoneModelKind;
  readonly sourceModelHash: DiagnosticResultHash;
  readonly version: number;
  readonly previousCorrectionHash: DiagnosticResultHash | null;
  readonly boundaries: readonly (number | null)[];
  readonly unit: string;
  readonly reason: string;
  readonly trainerId: string;
  readonly createdAt: string;
  readonly warnings: readonly string[];
  readonly correctionHash: DiagnosticResultHash;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function validateBoundaries(
  modelKind: TrainingZoneModelKind,
  values: readonly (number | null)[],
): readonly (number | null)[] {
  if (values.length === 0) throw new TypeError('Boundaries must not be empty');
  const copy = [...values];
  let previous: number | null = null;
  for (let index = 0; index < copy.length; index += 1) {
    const value = copy[index];
    const isAllowedOpenUpper =
      modelKind === 'THRESHOLD_HEART_RATE_ZONES' && index === copy.length - 1 && value === null;
    if (isAllowedOpenUpper) continue;
    if (value === null || !Number.isFinite(value) || value <= 0) {
      throw new TypeError('Boundaries must be positive finite numbers');
    }
    if (modelKind === 'THRESHOLD_HEART_RATE_ZONES' && !Number.isInteger(value)) {
      throw new TypeError('Heart-rate boundaries must be integers');
    }
    if (previous !== null && value <= previous) {
      throw new TypeError('Boundaries must be strictly increasing');
    }
    previous = value;
  }
  return Object.freeze(copy);
}

export async function createTrainingZoneCorrection(
  input: TrainingZoneCorrectionInput,
): Promise<TrainingZoneCorrection> {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new TypeError('Version must be a positive integer');
  }
  if (!SHA256_PATTERN.test(input.sourceModelHash)) {
    throw new TypeError('Source model hash must be a valid SHA-256 reference');
  }

  const previous = input.previousCorrection ?? null;
  if (input.version === 1 && previous !== null) {
    throw new TypeError('Version 1 must not reference a previous correction');
  }
  if (input.version > 1) {
    if (previous === null) throw new TypeError('Later versions require the previous correction');
    if (previous.version + 1 !== input.version) throw new TypeError('Correction versions must be consecutive');
    if (previous.sourceModelHash !== input.sourceModelHash || previous.modelKind !== input.modelKind) {
      throw new TypeError('Correction chain must reference the same source model');
    }
  }

  const createdAt = requiredText(input.createdAt, 'Created-at timestamp');
  if (new Date(createdAt).toISOString() !== createdAt) {
    throw new TypeError('Created-at timestamp must be canonical UTC ISO-8601');
  }

  const payload = {
    schemaVersion: 'training-zone-correction-v1' as const,
    correctionId: requiredText(input.correctionId, 'Correction ID'),
    modelKind: input.modelKind,
    sourceModelHash: input.sourceModelHash,
    version: input.version,
    previousCorrectionHash: previous?.correctionHash ?? null,
    boundaries: validateBoundaries(input.modelKind, input.boundaries),
    unit: requiredText(input.unit, 'Unit'),
    reason: requiredText(input.reason, 'Reason'),
    trainerId: requiredText(input.trainerId, 'Trainer ID'),
    createdAt,
    warnings: Object.freeze([...new Set((input.warnings ?? []).map((v) => v.trim()).filter(Boolean))]),
  };
  const correctionHash = await createDiagnosticResultHash(payload);
  return Object.freeze({ ...payload, correctionHash });
}
