export interface PlannedProtocol {
  expectedLt2Watts: number;
  startWatts: number;
  incrementWatts: number;
  stages: number[];
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function planFromExpectedLt2(
  expectedLt2Watts: number,
  maximumStages = 8,
): PlannedProtocol {
  if (!Number.isFinite(expectedLt2Watts) || expectedLt2Watts <= 0) {
    throw new RangeError('Expected LT2 must be a positive finite watt value.');
  }
  if (!Number.isInteger(maximumStages) || maximumStages < 5 || maximumStages > 12) {
    throw new RangeError('Maximum stages must be an integer between 5 and 12.');
  }
  const startWatts = roundTo(expectedLt2Watts * 0.6, 5);
  const incrementWatts = Math.max(5, roundTo((expectedLt2Watts - startWatts) / 4, 5));
  const stages = Array.from({ length: maximumStages }, (_, index) => startWatts + incrementWatts * index);
  return { expectedLt2Watts, startWatts, incrementWatts, stages };
}
