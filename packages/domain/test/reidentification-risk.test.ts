import { describe, expect, it } from 'vitest';
import { assessReidentificationRisk } from '../src';

describe('reidentification risk assessment', () => {
  it('fails closed when cohort evidence is unavailable', () => {
    expect(assessReidentificationRisk(
      { equivalenceClassSize: null },
      { minimumEquivalenceClassSize: 5 },
    )).toEqual({
      level: 'UNASSESSED',
      equivalenceClassSize: null,
      minimumEquivalenceClassSize: 5,
      exportAllowed: false,
      reason: 'COHORT_SIZE_UNAVAILABLE',
    });
  });

  it('warns and blocks export below the configured minimum', () => {
    expect(assessReidentificationRisk(
      { equivalenceClassSize: 3 },
      { minimumEquivalenceClassSize: 5 },
    )).toMatchObject({
      level: 'WARNING',
      equivalenceClassSize: 3,
      exportAllowed: false,
      reason: 'COHORT_BELOW_MINIMUM',
    });
  });

  it('clears export at the configured minimum', () => {
    expect(assessReidentificationRisk(
      { equivalenceClassSize: 5 },
      { minimumEquivalenceClassSize: 5 },
    )).toMatchObject({
      level: 'CLEAR',
      equivalenceClassSize: 5,
      exportAllowed: true,
      reason: 'COHORT_MEETS_MINIMUM',
    });
  });

  it('rejects invalid policy and evidence values', () => {
    expect(() => assessReidentificationRisk(
      { equivalenceClassSize: 1 },
      { minimumEquivalenceClassSize: 1 },
    )).toThrow('Minimum equivalence class size');
    expect(() => assessReidentificationRisk(
      { equivalenceClassSize: 0 },
      { minimumEquivalenceClassSize: 2 },
    )).toThrow('Equivalence class size');
  });
});
