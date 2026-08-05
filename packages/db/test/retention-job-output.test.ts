import { describe, expect, it } from 'vitest';
import { summarizeRetentionJobPlan } from '../src/services/retention-job-output';
import type { RetentionJobPlan } from '../src/services/retention';

const plan: Readonly<RetentionJobPlan> = Object.freeze({
  mode: 'READ_ONLY',
  assessedAt: '2027-07-31T00:00:00.000Z',
  tenantCount: 1,
  candidateCount: 2,
  eligibleCount: 1,
  manualReviewCount: 1,
  tenants: Object.freeze([
    Object.freeze({
      tenantId: 'tenant-sensitive-id',
      candidateCount: 2,
      eligibleCount: 1,
      manualReviewCount: 1,
      candidates: Object.freeze([
        Object.freeze({
          athleteId: 'athlete-sensitive-id',
          linkedUserId: 'user-sensitive-id',
          consentBlockedAt: null,
          deletedAt: null,
          disposition: 'MANUAL_REVIEW' as const,
          assessment: Object.freeze({
            basis: 'MANUAL_REVIEW' as const,
            reason: 'MANUAL_REVIEW_REQUIRED' as const,
            tenantRetentionYears: 10,
            referenceAt: null,
            retainUntil: null,
            eligibleForIrreversibleAction: false,
          }),
        }),
      ]),
    }),
  ]),
});

describe('retention job output minimization', () => {
  it('keeps only aggregate read-only counters for scheduled logs', () => {
    const summary = summarizeRetentionJobPlan(plan);
    expect(summary).toEqual({
      mode: 'READ_ONLY',
      assessedAt: '2027-07-31T00:00:00.000Z',
      tenantCount: 1,
      candidateCount: 2,
      eligibleCount: 1,
      manualReviewCount: 1,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('tenant-sensitive-id');
    expect(serialized).not.toContain('athlete-sensitive-id');
    expect(serialized).not.toContain('user-sensitive-id');
  });
});
