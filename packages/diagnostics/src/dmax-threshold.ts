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
const EPSILON = 1e-12;

function usablePoints(points: readonly DiagnosticPoint[]): DiagnosticPoint[] {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 4) {
    throw new Error('Dmax requires at least four included exact lactate points.');
  }

  for (const point of usable) {
    if (!Number.isFinite(point.watts) || !Number.isFinite(point.lactate)) {
      throw new TypeError('Dmax points must contain finite watts and lactate values.');
    }
  }

  for (let index = 1; index < usable.length; index += 1) {
    if (usable[index - 1]!.watts === usable[index]!.watts) {
      throw new Error('Dmax points must have distinct watt values.');
    }
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

function derivativeCandidates(
  regression: CubicLactateRegression,
  start: DiagnosticPoint,
  end: DiagnosticPoint,
): number[] {
  const [a0, a1, a2, a3] = regression.coefficients;
  void a0;
  const deltaWatts = end.watts - start.watts;
  const deltaLactate = end.lactate - start.lactate;
  const scale = regression.wattScale;

  const quadratic = 3 * a3;
  const linear = 2 * a2;
  const constant = a1 - (deltaLactate * scale) / deltaWatts;
  const normalizedRoots: number[] = [];

  if (Math.abs(quadratic) <= EPSILON) {
    if (Math.abs(linear) > EPSILON) {
      normalizedRoots.push(-constant / linear);
    }
  } else {
    const discriminant = linear * linear - 4 * quadratic * constant;
    if (discriminant >= -EPSILON) {
      const root = Math.sqrt(Math.max(0, discriminant));
      normalizedRoots.push(
        (-linear - root) / (2 * quadratic),
        (-linear + root) / (2 * quadratic),
      );
    }
  }

  return normalizedRoots
    .map((x) => regression.wattCenter + x * scale)
    .filter((watts) => watts > start.watts && watts < end.watts)
    .filter((watts, index, all) => all.findIndex((candidate) => Math.abs(candidate - watts) <= EPSILON) === index);
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

  const candidates = [
    start.watts,
    ...derivativeCandidates(regression, start, end),
    end.watts,
  ];

  const evaluated = candidates.map((watts) => {
    const lactate = predictCubicLactate(regression, watts);
    return {
      watts,
      lactate,
      distance: perpendicularDistance(watts, lactate, start, end),
    };
  });

  evaluated.sort((left, right) => (
    right.distance - left.distance || left.watts - right.watts
  ));
  const best = evaluated[0]!;
  const warnings = [...regression.warnings];
  const intervalWidth = end.watts - start.watts;
  const boundaryMargin = intervalWidth * 0.01;

  if (best.watts - start.watts <= boundaryMargin || end.watts - best.watts <= boundaryMargin) {
    warnings.push('DMAX_NEAR_BOUNDARY: maximum distance lies within 1% of the measured interval boundary.');
  }
  if (best.distance <= 1e-9) {
    warnings.push('DMAX_NEGLIGIBLE_DISTANCE: fitted curve has no meaningful separation from the reference line.');
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
    searchIntervalWatts: [start.watts, end.watts],
    regression,
  };
}
