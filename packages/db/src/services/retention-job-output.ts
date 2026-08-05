import type { RetentionJobPlan } from './retention';

export interface RetentionJobSummary {
  mode: 'READ_ONLY';
  assessedAt: string;
  tenantCount: number;
  candidateCount: number;
  eligibleCount: number;
  manualReviewCount: number;
}

/**
 * Minimizes scheduled retention output to aggregate operational counters. The
 * full plan remains available for an explicit administrative/manual scan.
 */
export function summarizeRetentionJobPlan(
  plan: Readonly<RetentionJobPlan>,
): Readonly<RetentionJobSummary> {
  return Object.freeze({
    mode: plan.mode,
    assessedAt: plan.assessedAt,
    tenantCount: plan.tenantCount,
    candidateCount: plan.candidateCount,
    eligibleCount: plan.eligibleCount,
    manualReviewCount: plan.manualReviewCount,
  });
}
