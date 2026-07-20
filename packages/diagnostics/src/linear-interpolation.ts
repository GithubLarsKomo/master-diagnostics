export function interpolateX(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  targetY: number,
): number {
  if (![x1, y1, x2, y2, targetY].every(Number.isFinite)) {
    throw new TypeError('All interpolation inputs must be finite numbers.');
  }
  if (y1 === y2) {
    throw new RangeError('Interpolation requires distinct y values.');
  }
  const ratio = (targetY - y1) / (y2 - y1);
  if (ratio < 0 || ratio > 1) {
    throw new RangeError('Extrapolation is not allowed.');
  }
  return x1 + ratio * (x2 - x1);
}
