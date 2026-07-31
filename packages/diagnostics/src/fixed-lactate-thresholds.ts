import { interpolateX } from './linear-interpolation';
import type { DiagnosticPoint, ThresholdEstimate } from './types';

export interface FixedLactateThresholdResult {
  lt1: ThresholdEstimate;
  lt2: ThresholdEstimate;
}

const ALGORITHM = 'fixed-lactate-2-4-mmol';
const VERSION = '1.0.0';

function usablePoints(points: readonly DiagnosticPoint[]): DiagnosticPoint[] {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 2) {
    throw new Error('At least two included exact lactate points are required.');
  }
  for (const point of usable) {
    if (!Number.isFinite(point.watts) || !Number.isFinite(point.lactate)) {
      throw new TypeError('Diagnostic points must contain finite watts and lactate values.');
    }
  }
  for (let index = 1; index < usable.length; index += 1) {
    if (usable[index - 1]!.watts === usable[index]!.watts) {
      throw new Error('Included diagnostic points must have distinct watt values.');
    }
  }
  return usable;
}

function estimateAt(
  points: readonly DiagnosticPoint[],
  targetLactate: number,
): ThresholdEstimate {
  const exact = points.filter((point) => point.lactate === targetLactate);
  if (exact.length > 1) {
    throw new Error(`Multiple included points equal ${targetLactate} mmol/L.`);
  }
  if (exact.length === 1) {
    const point = exact[0]!;
    return {
      watts: point.watts,
      lactate: targetLactate,
      ...(point.heartRate === undefined ? {} : { heartRate: point.heartRate }),
      algorithm: ALGORITHM,
      version: VERSION,
      warnings: [],
    };
  }

  const crossings: Array<[DiagnosticPoint, DiagnosticPoint]> = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!;
    const right = points[index]!;
    const crossesTarget = (
      (left.lactate < targetLactate && right.lactate > targetLactate)
      || (left.lactate > targetLactate && right.lactate < targetLactate)
    );
    if (crossesTarget) {
      crossings.push([left, right]);
    }
  }
  if (crossings.length === 0) {
    throw new Error(`No included exact points bracket ${targetLactate} mmol/L.`);
  }
  if (crossings.length > 1) {
    throw new Error(`Multiple intervals bracket ${targetLactate} mmol/L.`);
  }

  const [left, right] = crossings[0]!;
  if (left.lactate > right.lactate) {
    throw new Error(`The only interval crossing ${targetLactate} mmol/L is descending.`);
  }

  const watts = interpolateX(
    left.watts,
    left.lactate,
    right.watts,
    right.lactate,
    targetLactate,
  );
  const heartRate = (
    left.heartRate === undefined || right.heartRate === undefined
      ? undefined
      : interpolateX(
        left.heartRate,
        left.lactate,
        right.heartRate,
        right.lactate,
        targetLactate,
      )
  );

  return {
    watts,
    lactate: targetLactate,
    ...(heartRate === undefined ? {} : { heartRate }),
    algorithm: ALGORITHM,
    version: VERSION,
    warnings: [],
  };
}

export function calculateFixedLactateThresholds(
  points: readonly DiagnosticPoint[],
): FixedLactateThresholdResult {
  const usable = usablePoints(points);
  return {
    lt1: estimateAt(usable, 2),
    lt2: estimateAt(usable, 4),
  };
}
