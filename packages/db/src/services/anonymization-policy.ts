import type { AnonymizationPreviewScope } from './anonymization-preview';

export const ANONYMIZATION_POLICY_VERSION = '1.0.0' as const;

export type AnonymizationPolicyDisposition =
  | 'REDACT_DIRECT_IDENTIFIERS'
  | 'REWRITE_EMBEDDED_IDENTIFIERS'
  | 'REVIEW_RELATIONSHIP_DATA'
  | 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK'
  | 'VERIFY_AND_HANDLE_EXTERNAL_ARTIFACT'
  | 'USE_CONTROLLED_AUDIT_PRIVACY_PATH'
  | 'PRESERVE_AUDIT_REDACTION_PROOF'
  | 'CLEAN_UP_EPHEMERAL_EXPORT';

export type AnonymizationPolicyGate =
  | 'AUTOMATABLE_AFTER_ADMIN_APPROVAL'
  | 'POLICY_REVIEW_REQUIRED';

export interface AnonymizationPolicyScopeDecision {
  scope: string;
  disposition: AnonymizationPolicyDisposition;
  gate: AnonymizationPolicyGate;
  rowCount: number;
}

export interface AthleteAnonymizationPolicyEvaluation {
  policyVersion: typeof ANONYMIZATION_POLICY_VERSION;
  executionAllowed: false;
  decisions: ReadonlyArray<Readonly<AnonymizationPolicyScopeDecision>>;
  unresolvedScopes: ReadonlyArray<string>;
  blockers: ReadonlyArray<
    | 'ADMINISTRATIVE_APPROVAL_REQUIRED'
    | 'RELATIONSHIP_POLICY_REVIEW_REQUIRED'
    | 'DIAGNOSTIC_REIDENTIFICATION_REVIEW_REQUIRED'
    | 'EXTERNAL_ARTIFACT_VERIFICATION_REQUIRED'
    | 'GLOBAL_RETENTION_AND_NOTIFICATION_REVIEW_REQUIRED'
  >;
}

const rules: Readonly<Record<string, Readonly<{
  disposition: AnonymizationPolicyDisposition;
  gate: AnonymizationPolicyGate;
}>>> = Object.freeze({
  ATHLETE_PROFILE: Object.freeze({
    disposition: 'REDACT_DIRECT_IDENTIFIERS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  ATHLETE_SNAPSHOTS: Object.freeze({
    disposition: 'REWRITE_EMBEDDED_IDENTIFIERS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  TEST_PLAN_SNAPSHOTS: Object.freeze({
    disposition: 'REWRITE_EMBEDDED_IDENTIFIERS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  RELATIONSHIP_AND_PRIVACY_RECORDS: Object.freeze({
    disposition: 'REVIEW_RELATIONSHIP_DATA',
    gate: 'POLICY_REVIEW_REQUIRED',
  }),
  DIAGNOSTIC_AND_OPERATIONAL_RECORDS: Object.freeze({
    disposition: 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK',
    gate: 'POLICY_REVIEW_REQUIRED',
  }),
  REPORT_DATABASE_RECORDS: Object.freeze({
    disposition: 'VERIFY_AND_HANDLE_EXTERNAL_ARTIFACT',
    gate: 'POLICY_REVIEW_REQUIRED',
  }),
  AUDIT_PRIVACY_CANDIDATES: Object.freeze({
    disposition: 'USE_CONTROLLED_AUDIT_PRIVACY_PATH',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  PRIOR_AUDIT_REDACTION_PROOFS: Object.freeze({
    disposition: 'PRESERVE_AUDIT_REDACTION_PROOF',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  ACTIVE_TENANT_EXPORT_PACKAGES: Object.freeze({
    disposition: 'CLEAN_UP_EPHEMERAL_EXPORT',
    gate: 'POLICY_REVIEW_REQUIRED',
  }),
});

/**
 * Evaluates the read-only preview against versioned disposition rules. This is
 * intentionally fail-closed: it never authorizes execution and only identifies
 * which scopes may become automatable after explicit administrative approval
 * versus which scopes still need a policy decision or external verification.
 */
export function evaluateAnonymizationPolicy(
  scopes: ReadonlyArray<Readonly<AnonymizationPreviewScope>>,
  globalRequirements: ReadonlyArray<string>,
): Readonly<AthleteAnonymizationPolicyEvaluation> {
  const decisions = scopes.map((item) => {
    const rule = rules[item.scope];
    if (!rule) {
      return Object.freeze({
        scope: item.scope,
        disposition: 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK' as const,
        gate: 'POLICY_REVIEW_REQUIRED' as const,
        rowCount: item.rowCount,
      });
    }
    return Object.freeze({
      scope: item.scope,
      disposition: rule.disposition,
      gate: rule.gate,
      rowCount: item.rowCount,
    });
  });

  const unresolvedScopes = decisions
    .filter((decision) => decision.rowCount > 0 && decision.gate === 'POLICY_REVIEW_REQUIRED')
    .map((decision) => decision.scope)
    .sort();

  const blockers = new Set<AthleteAnonymizationPolicyEvaluation['blockers'][number]>();
  blockers.add('ADMINISTRATIVE_APPROVAL_REQUIRED');
  if (unresolvedScopes.includes('RELATIONSHIP_AND_PRIVACY_RECORDS')) {
    blockers.add('RELATIONSHIP_POLICY_REVIEW_REQUIRED');
  }
  if (unresolvedScopes.includes('DIAGNOSTIC_AND_OPERATIONAL_RECORDS')) {
    blockers.add('DIAGNOSTIC_REIDENTIFICATION_REVIEW_REQUIRED');
  }
  if (
    unresolvedScopes.includes('REPORT_DATABASE_RECORDS')
    || unresolvedScopes.includes('ACTIVE_TENANT_EXPORT_PACKAGES')
  ) {
    blockers.add('EXTERNAL_ARTIFACT_VERIFICATION_REQUIRED');
  }
  if (globalRequirements.length > 0) {
    blockers.add('GLOBAL_RETENTION_AND_NOTIFICATION_REVIEW_REQUIRED');
  }

  return Object.freeze({
    policyVersion: ANONYMIZATION_POLICY_VERSION,
    executionAllowed: false as const,
    decisions: Object.freeze(decisions),
    unresolvedScopes: Object.freeze(unresolvedScopes),
    blockers: Object.freeze([...blockers].sort()),
  });
}
