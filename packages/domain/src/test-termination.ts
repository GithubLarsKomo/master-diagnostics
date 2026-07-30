export const TEST_TERMINATION_REASONS = [
  'REGULAR_EXHAUSTION',
  'VOLUNTARY_STOP',
  'TECHNICAL_FAILURE',
  'PAIN_OR_DISCOMFORT',
  'ABNORMAL_HEART_RATE',
  'PROTOCOL_ERROR',
  'OTHER',
] as const;

export type TestTerminationReason = (typeof TEST_TERMINATION_REASONS)[number];

export const TEST_TERMINATION_NOTES_MAX_LENGTH = 2000;

export interface TestTerminationDetails {
  reason: TestTerminationReason;
  notes: string | null;
}

export function validateTestTerminationDetails(input: {
  reason: unknown;
  notes?: unknown;
}): TestTerminationDetails {
  if (
    typeof input.reason !== 'string'
    || !TEST_TERMINATION_REASONS.includes(input.reason as TestTerminationReason)
  ) {
    throw new Error('Invalid test termination reason');
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== 'string') {
    throw new Error('Test termination notes must be text');
  }

  const notes = typeof input.notes === 'string' ? input.notes.trim() || null : null;
  if (notes && notes.length > TEST_TERMINATION_NOTES_MAX_LENGTH) {
    throw new Error(`Test termination notes may not exceed ${TEST_TERMINATION_NOTES_MAX_LENGTH} characters`);
  }
  if (input.reason === 'OTHER' && !notes) {
    throw new Error('Test termination notes are required for OTHER');
  }

  return {
    reason: input.reason as TestTerminationReason,
    notes,
  };
}
