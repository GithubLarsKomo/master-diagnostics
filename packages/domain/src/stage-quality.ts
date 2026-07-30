export type AutomaticStageQualityStatus = 'VALID' | 'PARTIAL' | 'EXCLUDED';

export interface StageDurationClassification {
  actualSeconds: number;
  qualityStatus: AutomaticStageQualityStatus;
}

export function classifyStageDuration(
  plannedSeconds: number,
  actualSeconds: number,
  partialInclusionPercent: number,
): StageDurationClassification {
  if (!Number.isInteger(plannedSeconds) || plannedSeconds <= 0) {
    throw new Error('Planned stage duration must be a positive integer');
  }
  if (!Number.isFinite(actualSeconds) || actualSeconds < 0) {
    throw new Error('Actual stage duration must be a non-negative finite number');
  }
  if (
    !Number.isInteger(partialInclusionPercent)
    || partialInclusionPercent < 1
    || partialInclusionPercent > 100
  ) {
    throw new Error('Partial inclusion percent must be an integer between 1 and 100');
  }

  const normalizedActualSeconds = Math.min(
    plannedSeconds,
    Math.floor(actualSeconds),
  );
  if (normalizedActualSeconds === plannedSeconds) {
    return {
      actualSeconds: normalizedActualSeconds,
      qualityStatus: 'VALID',
    };
  }
  return {
    actualSeconds: normalizedActualSeconds,
    qualityStatus: (
      normalizedActualSeconds * 100
      >= plannedSeconds * partialInclusionPercent
    )
      ? 'PARTIAL'
      : 'EXCLUDED',
  };
}
