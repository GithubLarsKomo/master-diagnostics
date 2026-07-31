import { describe, expect, it } from 'vitest';
import { createTrainerDiagnosticDecision } from '../src/trainer-decision';

const fixedHash = `sha256:${'1'.repeat(64)}`;
const dmaxHash = `sha256:${'2'.repeat(64)}`;

describe('trainer diagnostic decision', () => {
  it('records an available method and alternatives', () => {
    const decision = createTrainerDiagnosticDecision({
      selectedMethod: 'DMAX',
      candidates: [
        { method: 'FIXED_2_4', available: true, resultHash: fixedHash },
        { method: 'DMAX', available: true, resultHash: dmaxHash },
        { method: 'MODIFIED_DMAX', available: false },
      ],
      rationale: 'Selected after reviewing the available diagnostic outputs.',
      decidedBy: 'trainer-1',
      decidedAt: '2026-07-31T21:30:00.000Z',
    });

    expect(decision.selectedResultHash).toBe(dmaxHash);
    expect(decision.alternatives).toHaveLength(2);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.alternatives)).toBe(true);
  });

  it('requires acknowledgement for selected warnings', () => {
    const input = {
      selectedMethod: 'FIXED_2_4' as const,
      candidates: [
        {
          method: 'FIXED_2_4' as const,
          available: true,
          resultHash: fixedHash,
          warnings: ['Result requires review'],
        },
      ],
      rationale: 'Selected after review.',
      decidedBy: 'trainer-1',
      decidedAt: '2026-07-31T21:30:00.000Z',
    };

    expect(() => createTrainerDiagnosticDecision(input)).toThrow('require an acknowledgement');
    expect(
      createTrainerDiagnosticDecision({
        ...input,
        warningAcknowledgement: 'Warning reviewed and accepted.',
      }).warningAcknowledgement,
    ).toBe('Warning reviewed and accepted.');
  });

  it('rejects unavailable, duplicate and untraceable selections', () => {
    expect(() =>
      createTrainerDiagnosticDecision({
        selectedMethod: 'DMAX',
        candidates: [{ method: 'DMAX', available: false }],
        rationale: 'Unavailable.',
        decidedBy: 'trainer-1',
        decidedAt: '2026-07-31T21:30:00.000Z',
      }),
    ).toThrow('not available');

    expect(() =>
      createTrainerDiagnosticDecision({
        selectedMethod: 'DMAX',
        candidates: [
          { method: 'DMAX', available: true, resultHash: dmaxHash },
          { method: 'DMAX', available: true, resultHash: dmaxHash },
        ],
        rationale: 'Duplicate.',
        decidedBy: 'trainer-1',
        decidedAt: '2026-07-31T21:30:00.000Z',
      }),
    ).toThrow('Duplicate diagnostic candidate');

    expect(() =>
      createTrainerDiagnosticDecision({
        selectedMethod: 'FIXED_2_4',
        candidates: [{ method: 'FIXED_2_4', available: true, resultHash: 'invalid' }],
        rationale: 'Missing hash.',
        decidedBy: 'trainer-1',
        decidedAt: '2026-07-31T21:30:00.000Z',
      }),
    ).toThrow('valid SHA-256 result hash');
  });
});
