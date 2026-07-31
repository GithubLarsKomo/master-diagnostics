import {
  fitCubicLactateRegression,
  predictCubicLactate,
  type CubicLactateRegression,
} from './cubic-lactate-regression';
import type { DiagnosticPoint, ThresholdEstimate } from './types';

export interface ModifiedDmaxThresholdResult {
  threshold: ThresholdEstimate;
  maximumDistance: number;
  startPoint: Readonly<DiagnosticPoint>;
  searchIntervalWatts: readonly [number, number];
  regression: CubicLactateRegression;
}

const ALGORITHM = 'modified-dmax-v1';
const VERSION = '1.0.0';
const RISE_THRESHOLD = 0.4;
const EPSILON = 1e-12;

function usablePoints(points: readonly DiagnosticPoint[]): DiagnosticPoint[] {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 4) {
    throw new Error('Modified Dmax requires at least four included exact lactate points.');
  }

  for (const point of usable) {
    if (!Number.isFinite(point.watts) || !Number.isFinite(point.lactate)) {
      throw new TypeError('Modified Dmax points must contain finite watts and lactate values.');
    }
    if (point.lactate < 0) {
      throw new TypeError('Modified Dmax lactate values must not be negative.');
    }
  }

  for (let index = 1; index < usable.length; index += 1) {
    if (usable[index - 1]!.watts === usable[index]!.watts) {
      throw new Error('Modified Dmax points must have distinct watt values.');
    }
  }

  return usable;
}

function findStartPoint(points: readonly DiagnosticPoint[]): DiagnosticPoint {
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.lactate - points[index - 1]!.lactate > RISE_THRESHOLD) {
      return points[index - 1]!;
    }
  }
  throw new Error('Modified Dmax requires a consecutive lactate rise greater than 0.4 mmol/l.');
}

function perpendicularDistance(
  watts: number,
  lactate: number,
  start: DiagnosticPoint,
  end: DiagnosticPoint,
): number {
  const deltaWatts = end.watts - start.watts;
  const deltaLactate = end.lactate - start.lactate;
  const denominator = Math.hypot(deltaWatts, deltaLactate);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new Error('Modified Dmax reference line requires distinct finite endpoints.');
  }

  return Math.abs(
    deltaLactate * watts
      - deltaWatts * lactate
      + end.watts * start.lactate
      - end.lactate * start.watts,
  ) / denominator;
}

function derivativeCandidates(
  regression: CubicLactateRegression,
  start: DiagnosticPoint,
  end: DiagnosticPoint,
): number[] {
  const [, a1, a2, a3] = regression.coefficients;
  const deltaWatts = end.watts - start.watts;
  const deltaLactate = end.lactate - start.lactate;
  const quadratic = 3 * a3;
  const linear = 2 * a2;
  const constant = a1 - (deltaLactate * regression.wattScale) / deltaWatts;
  const roots: number[] = [];

  if (Math.abs(quadratic) <= EPSILON) {
    if (Math.abs(linear) > EPSILON) roots.push(-constant / linear);
  } else {
    const discriminant = linear * linear - 4 * quadratic * constant;
    if (discriminant >= -EPSILON) {
      const root = Math.sqrt(Math.max(0, discriminant));
      roots.push(
        (-linear - root) / (2 * quadratic),
        (-linear + root) / (2 * quadratic),
      );
    }
  }

  return roots
    .map((x) => regression.wattCenter + x * regression.wattScale)
    .filter((watts) => watts > start.watts && watts < end.watts)
    .filter((watts, index, all) =>
      all.findIndex((candidate) => Math.abs(candidate - watts) <= EPSILON) === index,
    );
}

export function calculateModifiedDmaxThreshold(
  points: readonly DiagnosticPoint[],
): ModifiedDmaxThresholdResult {
  const usable = usablePoints(points);
  const start = findStartPoint(usable);
  const end = usable[usable.length - 1]!;
  if (start.watts >= end.watts) {
    throw new Error('Modified Dmax search interval requires the start point before the final point.');
  }

  const regression = fitCubicLactateRegression(usable);
  const candidates = [
    start.watts,
    ...derivativeCandidates(regression, start, end),
    end.watts,
  ];
  const evaluated = candidates.map((watts) => {
    const lactate = predictCubicLactate(regression, watts);
    const distance = perpendicularDistance(watts, lactate, start, end);
    if (!Number.isFinite(lactate) || !Number.isFinite(distance)) {
      throw new Error('Modified Dmax regression or distance search produced a non-finite result.');
    }
    return { watts, lactate, distance };
  });

  evaluated.sort((left, right) => right.distance - left.distance || left.watts - right.watts);
  const best = evaluated[0]!;
  const warnings = [...regression.warnings];
  const intervalWidth = end.watts - start.watts;
  if (best.watts - start.watts <= intervalWidth * 0.01 || end.watts - best.watts <= intervalWidth * 0.01) {
    warnings.push('MODIFIED_DMAX_NEAR_BOUNDARY: maximum distance lies within 1% of the search interval boundary.');
  }
  if (best.distance <= 1e-9) {
    warnings.push('MODIFIED_DMAX_NEGLIGIBLE_DISTANCE: fitted curve has no meaningful separation from the reference line.');
  }

  return {
    threshold: {
      watts: best.watts,
      lactate: best.lactate,
      algorithm: ALGORITHM,
      version: VERSION,
      warnings,
    },
    maximumDistance: best.distance,
    startPoint: Object.freeze({ ...start }),
    searchIntervalWatts: Object.freeze([start.watts, end.watts] as const),
    regression,
  };
}
