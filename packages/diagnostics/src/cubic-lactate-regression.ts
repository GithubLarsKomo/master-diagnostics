import type { DiagnosticPoint } from './types';

export type CubicCoefficients = readonly [number, number, number, number];

export interface CubicLactateRegression {
  coefficients: CubicCoefficients;
  wattCenter: number;
  wattScale: number;
  pointCount: number;
  rSquared: number;
  rmse: number;
  algorithm: 'cubic-lactate-least-squares';
  version: '1.0.0';
  warnings: string[];
}

const PIVOT_EPSILON = 1e-12;
const LOW_R_SQUARED_THRESHOLD = 0.95;

function usablePoints(points: readonly DiagnosticPoint[]): DiagnosticPoint[] {
  const usable = points
    .filter((point) => point.included)
    .filter((point) => point.lactateQualifier === undefined || point.lactateQualifier === 'EXACT')
    .map((point) => ({ ...point }))
    .sort((left, right) => left.watts - right.watts);

  if (usable.length < 4) {
    throw new Error('At least four included exact lactate points are required for cubic regression.');
  }

  for (const point of usable) {
    if (!Number.isFinite(point.watts) || !Number.isFinite(point.lactate)) {
      throw new TypeError('Regression points must contain finite watts and lactate values.');
    }
  }

  for (let index = 1; index < usable.length; index += 1) {
    if (usable[index - 1]!.watts === usable[index]!.watts) {
      throw new Error('Included regression points must have distinct watt values.');
    }
  }

  return usable;
}

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

    if (Math.abs(augmented[pivotRow]![column]!) < PIVOT_EPSILON) {
      throw new Error('Cubic regression design matrix is singular or numerically unstable.');
    }

    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[column]!];
    const pivot = augmented[column]![column]!;
    for (let entry = column; entry <= size; entry += 1) {
      augmented[column]![entry] = augmented[column]![entry]! / pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let entry = column; entry <= size; entry += 1) {
        augmented[row]![entry] = augmented[row]![entry]! - factor * augmented[column]![entry]!;
      }
    }
  }

  return augmented.map((row) => row[size]!);
}

export function predictCubicLactate(
  model: Pick<CubicLactateRegression, 'coefficients' | 'wattCenter' | 'wattScale'>,
  watts: number,
): number {
  if (!Number.isFinite(watts)) {
    throw new TypeError('Prediction watts must be finite.');
  }
  if (!Number.isFinite(model.wattCenter) || !Number.isFinite(model.wattScale) || model.wattScale <= 0) {
    throw new TypeError('Regression scaling parameters must be finite and wattScale must be positive.');
  }

  const x = (watts - model.wattCenter) / model.wattScale;
  const [a0, a1, a2, a3] = model.coefficients;
  return a0 + a1 * x + a2 * x ** 2 + a3 * x ** 3;
}

export function fitCubicLactateRegression(
  points: readonly DiagnosticPoint[],
): CubicLactateRegression {
  const usable = usablePoints(points);
  const wattCenter = usable.reduce((sum, point) => sum + point.watts, 0) / usable.length;
  const wattScale = Math.max(...usable.map((point) => Math.abs(point.watts - wattCenter)));

  if (!Number.isFinite(wattScale) || wattScale <= 0) {
    throw new Error('Cubic regression requires a positive watt range.');
  }

  const normalMatrix = Array.from({ length: 4 }, () => Array<number>(4).fill(0));
  const normalVector = Array<number>(4).fill(0);

  for (const point of usable) {
    const x = (point.watts - wattCenter) / wattScale;
    const powers = [1, x, x ** 2, x ** 3];
    for (let row = 0; row < 4; row += 1) {
      normalVector[row] = normalVector[row]! + powers[row]! * point.lactate;
      for (let column = 0; column < 4; column += 1) {
        normalMatrix[row]![column] = normalMatrix[row]![column]! + powers[row]! * powers[column]!;
      }
    }
  }

  const coefficients = solveLinearSystem(normalMatrix, normalVector) as [number, number, number, number];
  const provisional = { coefficients, wattCenter, wattScale };
  const meanLactate = usable.reduce((sum, point) => sum + point.lactate, 0) / usable.length;
  let sumSquaredError = 0;
  let totalSumSquares = 0;

  for (const point of usable) {
    const residual = point.lactate - predictCubicLactate(provisional, point.watts);
    sumSquaredError += residual ** 2;
    totalSumSquares += (point.lactate - meanLactate) ** 2;
  }

  const rSquared = totalSumSquares <= PIVOT_EPSILON
    ? (sumSquaredError <= PIVOT_EPSILON ? 1 : 0)
    : 1 - sumSquaredError / totalSumSquares;
  const rmse = Math.sqrt(sumSquaredError / usable.length);
  const warnings: string[] = [];

  if (rSquared < LOW_R_SQUARED_THRESHOLD) {
    warnings.push(`LOW_R_SQUARED: cubic regression R² is below ${LOW_R_SQUARED_THRESHOLD}.`);
  }

  return {
    coefficients,
    wattCenter,
    wattScale,
    pointCount: usable.length,
    rSquared,
    rmse,
    algorithm: 'cubic-lactate-least-squares',
    version: '1.0.0',
    warnings,
  };
}
