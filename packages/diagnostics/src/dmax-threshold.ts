import {
  fitCubicLactateRegression,
  predictCubicLactate,
  type CubicLactateRegression,
} from './cubic-lactate-regression';
import type { DiagnosticPoint, ThresholdEstimate } from './types';

export interface DmaxThresholdResult {
  threshold: ThresholdEstimate;
  maximumDistance: number;
  searchIntervalWatts: readonly [number, number];
  regression: CubicLactateRegression;
}

const ALGORITHM = 'dmax-cubic';
const VERSION = '1.0.0';
const ITERATIONS = 120;
const GOLDEN_RATIO_CONJUGATE = (Math.sqrt(5) - 1) / 2;

function usablePoints(points: readonly DiagnosticPoint[]): DiagnosticPoint[] {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 4) {
    throw new Error('Dmax requires at least four included exact lactate points.');
  }

  return usable;
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
    throw new Error('Dmax reference line requires distinct finite endpoints.');
  }

  const numerator = Math.abs(
    deltaLactate * watts
      - deltaWatts * lactate
      + end.watts * start.lactate
      - end.lactate * start.watts,
  );
  return numerator / denominator;
}

export function calculateDmaxThreshold(
  points: readonly DiagnosticPoint[],
): DmaxThresholdResult {
  const usable = usablePoints(points);
  const regression = fitCubicLactateRegression(usable);
  const start = usable[0]!;
  const end = usable[usable.length - 1]!;

  if (end.watts <= start.watts) {
    throw new Error('Dmax search interval requires increasing watt values.');
  }

  const distanceAt = (watts: number): number => perpendicularDistance(
    watts,
    predictCubicLactate(regression, watts),
    start,
    end,
  );

  let left = start.watts;
  let right = end.watts;
  let x1 = right - GOLDEN_RATIO_CONJUGATE * (right - left);
  let x2 = left + GOLDEN_RATIO_CONJUGATE * (right - left);
  let d1 = distanceAt(x1);
  let d2 = distanceAt(x2);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    if (d1 < d2) {
      left = x1;
      x1 = x2;
      d1 = d2;
      x2 = left + GOLDEN_RATIO_CONJUGATE * (right - left);
      d2 = distanceAt(x2);
    } else {
      right = x2;
      x2 = x1;
      d2 = d1;
      x1 = right - GOLDEN_RATIO_CONJUGATE * (right - left);
      d1 = distanceAt(x1);
    }
  }

  const watts = (left + right) / 2;
  const lactate = predictCubicLactate(regression, watts);
  const maximumDistance = distanceAt(watts);
  const warnings = [...regression.warnings];
  const intervalWidth = end.watts - start.watts;
  const boundaryMargin = intervalWidth * 0.01;

  if (watts - start.watts <= boundaryMargin || end.watts - watts <= boundaryMargin) {
    warnings.push('DMAX_NEAR_BOUNDARY: maximum distance lies within 1% of the measured interval boundary.');
  }
  if (maximumDistance <= 1e-9) {
    warnings.push('DMAX_NEGLIGIBLE_DISTANCE: fitted curve has no meaningful separation from the reference line.');
  }

  return {
    threshold: {
      watts,
      lactate,
      algorithm: ALGORITHM,
      version: VERSION,
      warnings,
    },
    maximumDistance,
    searchIntervalWatts: [start.watts, end.watts],
    regression,
  };
}
