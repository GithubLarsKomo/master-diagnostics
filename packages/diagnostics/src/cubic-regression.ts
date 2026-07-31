import type { DiagnosticPoint } from './types';

export interface CubicRegressionModel {
  algorithm: 'cubic-lactate-regression';
  version: '1.0.0';
  coefficients: readonly [number, number, number, number];
  normalization: {
    centerWatts: number;
    scaleWatts: number;
  };
  quality: {
    rSquared: number;
    rmse: number;
    pointCount: number;
  };
  warnings: string[];
  predictLactate(watts: number): number;
}

const EPSILON = 1e-12;

function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivotRow]![column]!)) {
        pivotRow = row;
      }
    }

    if (Math.abs(augmented[pivotRow]![column]!) < EPSILON) {
      throw new Error('Cubic regression design matrix is singular.');
    }

    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[column]!];
    const pivot = augmented[column]![column]!;
    for (let entry = column; entry <= size; entry += 1) {
      augmented[column]![entry] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let entry = column; entry <= size; entry += 1) {
        augmented[row]![entry] -= factor * augmented[column]![entry]!;
      }
    }
  }

  return augmented.map((row) => row[size]!);
}

function usablePoints(points: readonly DiagnosticPoint[]): DiagnosticPoint[] {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 4) {
    throw new Error('Cubic regression requires at least four included exact lactate points.');
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

export function fitCubicLactateRegression(
  points: readonly DiagnosticPoint[],
): CubicRegressionModel {
  const usable = usablePoints(points);
  const centerWatts = usable.reduce((sum, point) => sum + point.watts, 0) / usable.length;
  const scaleWatts = Math.max(...usable.map((point) => Math.abs(point.watts - centerWatts)));

  if (!Number.isFinite(scaleWatts) || scaleWatts <= 0) {
    throw new Error('Cubic regression requires a non-zero watt range.');
  }

  const rows = usable.map((point) => {
    const x = (point.watts - centerWatts) / scaleWatts;
    return [1, x, x ** 2, x ** 3];
  });

  const normalMatrix = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) =>
      rows.reduce((sum, values) => sum + values[row]! * values[column]!, 0),
    ),
  );
  const normalVector = Array.from({ length: 4 }, (_, row) =>
    rows.reduce((sum, values, index) => sum + values[row]! * usable[index]!.lactate, 0),
  );

  const coefficients = solveLinearSystem(normalMatrix, normalVector) as [number, number, number, number];
  const predictLactate = (watts: number): number => {
    if (!Number.isFinite(watts)) {
      throw new TypeError('Prediction watts must be finite.');
    }
    const x = (watts - centerWatts) / scaleWatts;
    return coefficients[0] + coefficients[1] * x + coefficients[2] * x ** 2 + coefficients[3] * x ** 3;
  };

  const residuals = usable.map((point) => point.lactate - predictLactate(point.watts));
  const sumSquaredError = residuals.reduce((sum, residual) => sum + residual ** 2, 0);
  const meanLactate = usable.reduce((sum, point) => sum + point.lactate, 0) / usable.length;
  const totalSumSquares = usable.reduce(
    (sum, point) => sum + (point.lactate - meanLactate) ** 2,
    0,
  );
  const rSquared = totalSumSquares <= EPSILON ? 1 : 1 - sumSquaredError / totalSumSquares;
  const rmse = Math.sqrt(sumSquaredError / usable.length);
  const warnings: string[] = [];

  if (usable.length === 4) {
    warnings.push('EXACT_FOUR_POINT_FIT');
  }
  if (rSquared < 0.9) {
    warnings.push('LOW_R_SQUARED');
  }

  return {
    algorithm: 'cubic-lactate-regression',
    version: '1.0.0',
    coefficients,
    normalization: { centerWatts, scaleWatts },
    quality: { rSquared, rmse, pointCount: usable.length },
    warnings,
    predictLactate,
  };
}
