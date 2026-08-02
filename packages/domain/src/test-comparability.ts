export type TestComparability = 'DIRECT' | 'LIMITED' | 'NOT_COMPARABLE';

export type TestComparabilityReason =
  | 'DEVICE_TYPE_MISMATCH'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'START_POWER_MISMATCH'
  | 'INCREMENT_MISMATCH'
  | 'STAGE_COUNT_MISMATCH';

export interface TestComparabilityInput {
  deviceType: string;
  protocolVersionId: string;
  startWatts: number;
  incrementWatts: number;
  maximumStages: number;
}

export interface TestComparabilityResult {
  classification: TestComparability;
  reasons: ReadonlyArray<TestComparabilityReason>;
}

export function classifyTestComparability(
  reference: TestComparabilityInput,
  candidate: TestComparabilityInput,
): Readonly<TestComparabilityResult> {
  const reasons: TestComparabilityReason[] = [];

  if (candidate.deviceType !== reference.deviceType) reasons.push('DEVICE_TYPE_MISMATCH');
  if (candidate.protocolVersionId !== reference.protocolVersionId) reasons.push('PROTOCOL_VERSION_MISMATCH');
  if (candidate.startWatts !== reference.startWatts) reasons.push('START_POWER_MISMATCH');
  if (candidate.incrementWatts !== reference.incrementWatts) reasons.push('INCREMENT_MISMATCH');
  if (candidate.maximumStages !== reference.maximumStages) reasons.push('STAGE_COUNT_MISMATCH');

  const classification: TestComparability = reasons.includes('DEVICE_TYPE_MISMATCH')
    ? 'NOT_COMPARABLE'
    : reasons.length === 0
      ? 'DIRECT'
      : 'LIMITED';

  return Object.freeze({
    classification,
    reasons: Object.freeze(reasons),
  });
}
