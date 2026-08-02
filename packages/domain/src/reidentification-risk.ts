export type ReidentificationRiskLevel = 'UNASSESSED' | 'WARNING' | 'CLEAR';

export interface ReidentificationRiskPolicy {
  minimumEquivalenceClassSize: number;
}

export interface ReidentificationRiskEvidence {
  equivalenceClassSize: number | null;
}

export interface ReidentificationRiskAssessment {
  level: ReidentificationRiskLevel;
  equivalenceClassSize: number | null;
  minimumEquivalenceClassSize: number;
  exportAllowed: boolean;
  reason:
    | 'COHORT_SIZE_UNAVAILABLE'
    | 'COHORT_BELOW_MINIMUM'
    | 'COHORT_MEETS_MINIMUM';
}

function assertPolicy(policy: ReidentificationRiskPolicy): void {
  if (!Number.isInteger(policy.minimumEquivalenceClassSize)
    || policy.minimumEquivalenceClassSize < 2) {
    throw new Error('Minimum equivalence class size must be an integer >= 2');
  }
}

function assertEvidence(evidence: ReidentificationRiskEvidence): void {
  if (evidence.equivalenceClassSize !== null
    && (!Number.isInteger(evidence.equivalenceClassSize) || evidence.equivalenceClassSize < 1)) {
    throw new Error('Equivalence class size must be null or an integer >= 1');
  }
}

/**
 * Evaluates whether an anonymized analysis export belongs to a sufficiently
 * large equivalence class under a caller-supplied privacy policy.
 *
 * This intentionally does not define a repository-wide k value. Policy remains
 * an explicit deployment/privacy decision, while the domain result is stable
 * and machine-readable. Missing cohort evidence fails closed.
 */
export function assessReidentificationRisk(
  evidence: ReidentificationRiskEvidence,
  policy: ReidentificationRiskPolicy,
): Readonly<ReidentificationRiskAssessment> {
  assertPolicy(policy);
  assertEvidence(evidence);

  if (evidence.equivalenceClassSize === null) {
    return Object.freeze({
      level: 'UNASSESSED',
      equivalenceClassSize: null,
      minimumEquivalenceClassSize: policy.minimumEquivalenceClassSize,
      exportAllowed: false,
      reason: 'COHORT_SIZE_UNAVAILABLE',
    });
  }

  if (evidence.equivalenceClassSize < policy.minimumEquivalenceClassSize) {
    return Object.freeze({
      level: 'WARNING',
      equivalenceClassSize: evidence.equivalenceClassSize,
      minimumEquivalenceClassSize: policy.minimumEquivalenceClassSize,
      exportAllowed: false,
      reason: 'COHORT_BELOW_MINIMUM',
    });
  }

  return Object.freeze({
    level: 'CLEAR',
    equivalenceClassSize: evidence.equivalenceClassSize,
    minimumEquivalenceClassSize: policy.minimumEquivalenceClassSize,
    exportAllowed: true,
    reason: 'COHORT_MEETS_MINIMUM',
  });
}
