import type { Database } from '../client';
import {
  getAthleteAnonymizationPreview,
  type AnonymizationPreviewScope,
  type AthleteAnonymizationPreview,
} from './anonymization-preview';

export const ANONYMIZATION_POLICY_VERSION = '1.2.0' as const;

export type AnonymizationPolicyDisposition =
  | 'REDACT_DIRECT_IDENTIFIERS'
  | 'REMOVE_ATHLETE_SNAPSHOTS'
  | 'REMOVE_TEST_PLAN_SNAPSHOTS'
  | 'REMOVE_COACH_RELATIONSHIPS'
  | 'PRESERVE_MINIMIZED_CONSENT_RECORDS'
  | 'REMOVE_GUARDIAN_RECORDS'
  | 'REDACT_DELETION_REQUEST_FREE_TEXT'
  | 'REMOVE_DIAGNOSTIC_AND_OPERATIONAL_RECORDS'
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
    | 'EXTERNAL_ARTIFACT_VERIFICATION_REQUIRED'
    | 'GLOBAL_RETENTION_AND_NOTIFICATION_REVIEW_REQUIRED'
  >;
}

export interface AthleteAnonymizationPolicyPreview {
  preview: Readonly<AthleteAnonymizationPreview>;
  policy: Readonly<AthleteAnonymizationPolicyEvaluation>;
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
    disposition: 'REMOVE_ATHLETE_SNAPSHOTS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  TEST_PLAN_SNAPSHOTS: Object.freeze({
    disposition: 'REMOVE_TEST_PLAN_SNAPSHOTS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  COACH_ASSIGNMENTS: Object.freeze({
    disposition: 'REMOVE_COACH_RELATIONSHIPS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  CONSENT_RECORDS: Object.freeze({
    disposition: 'PRESERVE_MINIMIZED_CONSENT_RECORDS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  GUARDIAN_RECORDS: Object.freeze({
    disposition: 'REMOVE_GUARDIAN_RECORDS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  DELETION_REQUESTS: Object.freeze({
    disposition: 'REDACT_DELETION_REQUEST_FREE_TEXT',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
  DIAGNOSTIC_AND_OPERATIONAL_RECORDS: Object.freeze({
    disposition: 'REMOVE_DIAGNOSTIC_AND_OPERATIONAL_RECORDS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
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
 *
 * Policy v1.2 deliberately chooses deletion for individualized diagnostic and
 * operational records instead of claiming that removal of direct identifiers
 * alone makes detailed physiological time series irreversibly anonymous.
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

/**
 * Single fail-closed entrypoint for callers that need both the current read-only
 * scope inventory and its versioned policy evaluation. It cannot authorize or
 * execute irreversible processing.
 */
export async function getAthleteAnonymizationPolicyPreview(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<AthleteAnonymizationPolicyPreview>> {
  const preview = await getAthleteAnonymizationPreview(db, tenantId, athleteId, assessedAt);
  const policy = evaluateAnonymizationPolicy(preview.scopes, preview.globalRequirements);
  return Object.freeze({ preview, policy });
}
