import { describe, expect, it } from 'vitest';
import { evaluateAnonymizationPolicy } from '../src/services/anonymization-policy';

const scopes = [
  { scope: 'ATHLETE_PROFILE', disposition: 'DIRECT_IDENTIFIER_REDACTION_REQUIRED', rowCount: 1, references: [] },
  { scope: 'ATHLETE_SNAPSHOTS', disposition: 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', rowCount: 2, references: [] },
  { scope: 'TEST_PLAN_SNAPSHOTS', disposition: 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', rowCount: 1, references: [] },
  { scope: 'COACH_ASSIGNMENTS', disposition: 'RELATIONSHIP_LINK_REMOVAL_REQUIRED', rowCount: 2, references: [] },
  { scope: 'CONSENT_RECORDS', disposition: 'MINIMIZED_COMPLIANCE_RECORD_REQUIRED', rowCount: 1, references: [] },
  { scope: 'GUARDIAN_RECORDS', disposition: 'THIRD_PARTY_RECORD_REMOVAL_REQUIRED', rowCount: 1, references: [] },
  { scope: 'DELETION_REQUESTS', disposition: 'FREE_TEXT_REDACTION_REQUIRED', rowCount: 1, references: [] },
  { scope: 'DIAGNOSTIC_AND_OPERATIONAL_RECORDS', disposition: 'REIDENTIFICATION_RISK_REVIEW_REQUIRED', rowCount: 12, references: [] },
  { scope: 'REPORT_DATABASE_RECORDS', disposition: 'EXTERNAL_ARTIFACT_HANDLING_REQUIRED', rowCount: 2, references: ['reports/a.pdf'] },
  { scope: 'AUDIT_PRIVACY_CANDIDATES', disposition: 'AUDIT_PRIVACY_REDACTION_REQUIRED', rowCount: 1, references: ['audit-a'] },
  { scope: 'PRIOR_AUDIT_REDACTION_PROOFS', disposition: 'AUDIT_PRIVACY_REDACTION_REQUIRED', rowCount: 1, references: [] },
  { scope: 'ACTIVE_TENANT_EXPORT_PACKAGES', disposition: 'EPHEMERAL_EXPORT_CLEANUP_REQUIRED', rowCount: 1, references: ['exports/current.zip'] },
] as const;

const globalRequirements = [
  'REPORT_STORAGE_VERIFICATION',
  'BACKUP_RETENTION_POLICY_REVIEW',
  'NOTIFICATION_PAYLOAD_REVIEW',
] as const;

describe('anonymization disposition policy v1.5', () => {
  it('minimizes the complete athlete profile instead of only direct identifiers', () => {
    const result = evaluateAnonymizationPolicy(scopes, globalRequirements);

    expect(result.policyVersion).toBe('1.5.0');
    expect(result.decisions).toContainEqual(expect.objectContaining({
      scope: 'ATHLETE_PROFILE',
      disposition: 'MINIMIZE_ATHLETE_TOMBSTONE',
      gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL',
    }));
    expect(result.executionAllowed).toBe(false);
    expect(result.unresolvedScopes).toEqual([]);
    expect(result.requiredGlobalCapabilities).toEqual([
      'BACKUP_PRIVACY_POLICY_V1',
      'NOTIFICATION_PRIVACY_POLICY_V1',
    ]);
    expect(result.blockers).toEqual([
      'ADMINISTRATIVE_APPROVAL_REQUIRED',
      'GLOBAL_PRIVACY_CAPABILITY_ATTESTATION_REQUIRED',
    ]);
  });

  it('removes the capability blocker only after explicit runtime attestation succeeds', () => {
    const result = evaluateAnonymizationPolicy(scopes, globalRequirements, true);
    expect(result.executionAllowed).toBe(false);
    expect(result.unresolvedGlobalRequirements).toEqual([]);
    expect(result.blockers).toEqual(['ADMINISTRATIVE_APPROVAL_REQUIRED']);
  });

  it('fails closed for unknown future row-level and global requirements', () => {
    const result = evaluateAnonymizationPolicy([
      { scope: 'FUTURE_NEW_SCOPE', disposition: 'REIDENTIFICATION_RISK_REVIEW_REQUIRED', rowCount: 1, references: [] },
    ], ['FUTURE_GLOBAL_REQUIREMENT'], true);

    expect(result.executionAllowed).toBe(false);
    expect(result.unresolvedScopes).toEqual(['FUTURE_NEW_SCOPE']);
    expect(result.unresolvedGlobalRequirements).toEqual(['FUTURE_GLOBAL_REQUIREMENT']);
    expect(result.requiredGlobalCapabilities).toEqual([]);
    expect(result.blockers).toEqual([
      'ADMINISTRATIVE_APPROVAL_REQUIRED',
      'UNRESOLVED_GLOBAL_POLICY_REQUIREMENT',
    ]);
    expect(result.decisions[0]).toMatchObject({
      disposition: 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK',
      gate: 'POLICY_REVIEW_REQUIRED',
    });
  });
});
