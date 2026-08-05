import type { Database } from '../client';
import {
  getAthleteAnonymizationPreview,
  type AnonymizationPreviewScope,
  type AthleteAnonymizationPreview,
} from './anonymization-preview';
import {
  evaluateGlobalPrivacyCapabilities,
  type GlobalPrivacyCapabilities,
  type GlobalPrivacyCapabilityEvaluation,
} from './global-privacy-policy';

export const ANONYMIZATION_POLICY_VERSION = '1.5.0' as const;

export type AnonymizationPolicyDisposition =
  | 'MINIMIZE_ATHLETE_TOMBSTONE'
  | 'REMOVE_ATHLETE_SNAPSHOTS'
  | 'REMOVE_TEST_PLAN_SNAPSHOTS'
  | 'REMOVE_COACH_RELATIONSHIPS'
  | 'PRESERVE_MINIMIZED_CONSENT_RECORDS'
  | 'REMOVE_GUARDIAN_RECORDS'
  | 'REDACT_DELETION_REQUEST_FREE_TEXT'
  | 'REMOVE_DIAGNOSTIC_AND_OPERATIONAL_RECORDS'
  | 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK'
  | 'REMOVE_REPORT_ARTIFACTS_AND_RECORDS'
  | 'USE_CONTROLLED_AUDIT_PRIVACY_PATH'
  | 'PRESERVE_AUDIT_REDACTION_PROOF'
  | 'REMOVE_ACTIVE_TENANT_EXPORT_PACKAGES';

export type AnonymizationPolicyGate =
  | 'AUTOMATABLE_AFTER_ADMIN_APPROVAL'
  | 'POLICY_REVIEW_REQUIRED';

export type RequiredGlobalPrivacyCapability =
  | 'BACKUP_PRIVACY_POLICY_V1'
  | 'NOTIFICATION_PRIVACY_POLICY_V1';

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
  unresolvedGlobalRequirements: ReadonlyArray<string>;
  requiredGlobalCapabilities: ReadonlyArray<RequiredGlobalPrivacyCapability>;
  blockers: ReadonlyArray<
    | 'ADMINISTRATIVE_APPROVAL_REQUIRED'
    | 'GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED'
    | 'UNRESOLVED_GLOBAL_POLICY_REQUIREMENT'
  >;
}

export interface AthleteAnonymizationPolicyPreview {
  preview: Readonly<AthleteAnonymizationPreview>;
  policy: Readonly<AthleteAnonymizationPolicyEvaluation>;
  globalPrivacy: Readonly<GlobalPrivacyCapabilityEvaluation>;
}

const rules: Readonly<Record<string, Readonly<{
  disposition: AnonymizationPolicyDisposition;
  gate: AnonymizationPolicyGate;
}>>> = Object.freeze({
  ATHLETE_PROFILE: Object.freeze({
    disposition: 'MINIMIZE_ATHLETE_TOMBSTONE',
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
    disposition: 'REMOVE_REPORT_ARTIFACTS_AND_RECORDS',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
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
    disposition: 'REMOVE_ACTIVE_TENANT_EXPORT_PACKAGES',
    gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
  }),
});

const knownGlobalRequirements = new Set([
  'REPORT_STORAGE_VERIFICATION',
  'BACKUP_RETENTION_POLICY_REVIEW',
  'NOTIFICATION_PAYLOAD_REVIEW',
]);

/**
 * Evaluates the read-only preview against versioned disposition rules. Policy
 * v1.5 strengthens the athlete-profile rule from direct-identifier redaction to
 * a minimal technical tombstone because birth date, body dimensions, sport,
 * discipline and training status are also potential quasi-identifiers.
 *
 * All earlier approvals are intentionally invalidated by the policy-version
 * change and must be explicitly re-approved against this stronger contract.
 */
export function evaluateAnonymizationPolicy(
  scopes: ReadonlyArray<Readonly<AnonymizationPreviewScope>>,
  globalRequirements: ReadonlyArray<string>,
  globalPrivacyReady = false,
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

  const unresolvedGlobalRequirements = globalRequirements
    .filter((requirement) => !knownGlobalRequirements.has(requirement))
    .sort();

  const requiredGlobalCapabilities: RequiredGlobalPrivacyCapability[] = [];
  if (globalRequirements.includes('BACKUP_RETENTION_POLICY_REVIEW')) {
    requiredGlobalCapabilities.push('BACKUP_PRIVACY_POLICY_V1');
  }
  if (globalRequirements.includes('NOTIFICATION_PAYLOAD_REVIEW')) {
    requiredGlobalCapabilities.push('NOTIFICATION_PRIVACY_POLICY_V1');
  }

  const blockers = new Set<AthleteAnonymizationPolicyEvaluation['blockers'][number]>();
  blockers.add('ADMINISTRATIVE_APPROVAL_REQUIRED');
  if (requiredGlobalCapabilities.length > 0 && !globalPrivacyReady) {
    blockers.add('GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED');
  }
  if (unresolvedGlobalRequirements.length > 0) {
    blockers.add('UNRESOLVED_GLOBAL_POLICY_REQUIREMENT');
  }

  return Object.freeze({
    policyVersion: ANONYMIZATION_POLICY_VERSION,
    executionAllowed: false as const,
    decisions: Object.freeze(decisions),
    unresolvedScopes: Object.freeze(unresolvedScopes),
    unresolvedGlobalRequirements: Object.freeze(unresolvedGlobalRequirements),
    requiredGlobalCapabilities: Object.freeze(requiredGlobalCapabilities.sort()),
    blockers: Object.freeze([...blockers].sort()),
  });
}

export async function getAthleteAnonymizationPolicyPreview(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
  globalCapabilities?: Readonly<GlobalPrivacyCapabilities>,
): Promise<Readonly<AthleteAnonymizationPolicyPreview>> {
  const preview = await getAthleteAnonymizationPreview(db, tenantId, athleteId, assessedAt);
  const globalPrivacy = evaluateGlobalPrivacyCapabilities(globalCapabilities);
  const policy = evaluateAnonymizationPolicy(
    preview.scopes,
    preview.globalRequirements,
    globalPrivacy.readyForIrreversibleProcessing,
  );
  return Object.freeze({ preview, policy, globalPrivacy });
}
