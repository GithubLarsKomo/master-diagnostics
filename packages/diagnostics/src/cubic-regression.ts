import type { DiagnosticPoint } from './types';

export interface CubicRegressionModel {
  coefficients: readonly [number, number, number, number];
  centerWatts: number;
  scaleWatts: number;
  rSquared: number;
  rmse: number;
  pointCount: number;
  algorithm: 'cubic-lactate-regression';
  version: '1.0.0';
  warnings: string[];
  predictLactate: (watts: number) => number;
}

const EPSILON = 1e-12;

function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);

  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[best]![pivot]!)) best = row;
    }
    [augmented[pivot], augmented[best]] = [augmented[best]!, augmented[pivot]!];
    const pivotValue = augmented[pivot]![pivot]!;
    if (Math.abs(pivotValue) < EPSILON) {
      throw new Error('Cubic regression design matrix is singular.');
    }
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot]![column] = augmented[pivot]![column]! / pivotValue;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]!;
      for (let column = pivot; column <= size; column += 1) {
        augmented[row]![column] = augmented[row]![column]! - factor * augmented[pivot]![column]!;
      }
    }
  }

  return augmented.map((row) => row[size]!);
}

export function fitCubicLactateRegression(points: readonly DiagnosticPoint[]): CubicRegressionModel {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 4) throw new Error('At least four included exact points are required.');
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

  const centerWatts = usable.reduce((sum, point) => sum + point.watts, 0) / usable.length;
  const scaleWatts = Math.max(...usable.map((point) => Math.abs(point.watts - centerWatts)));
  if (!Number.isFinite(scaleWatts) || scaleWatts <= 0) throw new Error('Cubic regression requires a non-zero watt range.');

  const rows = usable.map((point) => {
    const x = (point.watts - centerWatts) / scaleWatts;
    return [1, x, x * x, x * x * x];
  });
  const normal = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => rows.reduce((sum, values) => sum + values[row]! * values[column]!, 0)),
  );
  const target = Array.from({ length: 4 }, (_, row) =>
    rows.reduce((sum, values, index) => sum + values[row]! * usable[index]!.lactate, 0),
  );
  const coefficients = solveLinearSystem(normal, target) as [number, number, number, number];
  const predictLactate = (watts: number): number => {
    if (!Number.isFinite(watts)) throw new TypeError('Prediction watts must be finite.');
    const x = (watts - centerWatts) / scaleWatts;
    return coefficients[0] + coefficients[1] * x + coefficients[2] * x * x + coefficients[3] * x * x * x;
  };

  const mean = usable.reduce((sum, point) => sum + point.lactate, 0) / usable.length;
  const residualSumSquares = usable.reduce((sum, point) => {
    const residual = point.lactate - predictLactate(point.watts);
    return sum + residual * residual;
  }, 0);
  const totalSumSquares = usable.reduce((sum, point) => {
    const deviation = point.lactate - mean;
    return sum + deviation * deviation;
  }, 0);
  const rSquared = totalSumSquares <= EPSILON ? 1 : 1 - residualSumSquares / totalSumSquares;
  const rmse = Math.sqrt(residualSumSquares / usable.length);
  const warnings: string[] = [];
  if (rSquared < 0.9) warnings.push('LOW_MODEL_FIT');

  return {
    coefficients,
    centerWatts,
    scaleWatts,
    rSquared,
    rmse,
    pointCount: usable.length,
    algorithm: 'cubic-lactate-regression',
    version: '1.0.0',
    warnings,
    predictLactate,
  };
}
