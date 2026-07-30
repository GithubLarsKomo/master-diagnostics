import { describe, expect, it } from 'vitest';
import {
  TEST_TERMINATION_REASONS,
  validateTestTerminationDetails,
} from '../src/test-termination';

describe('test termination details', () => {
  it('keeps the specified completion and abort reasons complete', () => {
    expect(TEST_TERMINATION_REASONS).toEqual([
      'REGULAR_EXHAUSTION',
      'VOLUNTARY_STOP',
      'TECHNICAL_FAILURE',
      'PAIN_OR_DISCOMFORT',
      'ABNORMAL_HEART_RATE',
      'PROTOCOL_ERROR',
      'OTHER',
    ]);
  });

  it('normalizes optional notes and requires context for OTHER', () => {
    expect(validateTestTerminationDetails({
      reason: 'TECHNICAL_FAILURE',
      notes: '  Sensor disconnected  ',
    })).toEqual({ reason: 'TECHNICAL_FAILURE', notes: 'Sensor disconnected' });
    expect(validateTestTerminationDetails({ reason: 'REGULAR_EXHAUSTION' }))
      .toEqual({ reason: 'REGULAR_EXHAUSTION', notes: null });

    expect(() => validateTestTerminationDetails({ reason: 'OTHER', notes: '  ' }))
      .toThrow('notes are required for OTHER');
    expect(() => validateTestTerminationDetails({ reason: 'UNKNOWN' }))
      .toThrow('Invalid test termination reason');
    expect(() => validateTestTerminationDetails({
      reason: 'VOLUNTARY_STOP',
      notes: 'x'.repeat(2001),
    })).toThrow('may not exceed 2000 characters');
  });
});
