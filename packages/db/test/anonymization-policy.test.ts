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

describe('anonymization disposition policy v1.2', () => {
  it('chooses deletion for individualized diagnostic data and leaves only artifact/global gates unresolved', () => {
    const result = evaluateAnonymizationPolicy(scopes, [
      'REPORT_STORAGE_VERIFICATION',
      'BACKUP_RETENTION_POLICY_REVIEW',
      'NOTIFICATION_PAYLOAD_REVIEW',
    ]);

    expect(result.policyVersion).toBe('1.2.0');
    expect(result.executionAllowed).toBe(false);
    expect(result.unresolvedScopes).toEqual([
      'ACTIVE_TENANT_EXPORT_PACKAGES',
      'REPORT_DATABASE_RECORDS',
    ]);
    expect(result.blockers).toEqual([
      'ADMINISTRATIVE_APPROVAL_REQUIRED',
      'EXTERNAL_ARTIFACT_VERIFICATION_REQUIRED',
      'GLOBAL_RETENTION_AND_NOTIFICATION_REVIEW_REQUIRED',
    ]);
    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'ATHLETE_PROFILE', disposition: 'REDACT_DIRECT_IDENTIFIERS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'ATHLETE_SNAPSHOTS', disposition: 'REMOVE_ATHLETE_SNAPSHOTS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'TEST_PLAN_SNAPSHOTS', disposition: 'REMOVE_TEST_PLAN_SNAPSHOTS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'COACH_ASSIGNMENTS', disposition: 'REMOVE_COACH_RELATIONSHIPS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'CONSENT_RECORDS', disposition: 'PRESERVE_MINIMIZED_CONSENT_RECORDS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'GUARDIAN_RECORDS', disposition: 'REMOVE_GUARDIAN_RECORDS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'DELETION_REQUESTS', disposition: 'REDACT_DELETION_REQUEST_FREE_TEXT', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'DIAGNOSTIC_AND_OPERATIONAL_RECORDS', disposition: 'REMOVE_DIAGNOSTIC_AND_OPERATIONAL_RECORDS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'AUDIT_PRIVACY_CANDIDATES', disposition: 'USE_CONTROLLED_AUDIT_PRIVACY_PATH', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'PRIOR_AUDIT_REDACTION_PROOFS', disposition: 'PRESERVE_AUDIT_REDACTION_PROOF', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
    ]));
  });

  it('fails closed for unknown future scopes', () => {
    const result = evaluateAnonymizationPolicy([
      { scope: 'FUTURE_NEW_SCOPE', disposition: 'REIDENTIFICATION_RISK_REVIEW_REQUIRED', rowCount: 1, references: [] },
    ], []);

    expect(result.executionAllowed).toBe(false);
    expect(result.unresolvedScopes).toEqual(['FUTURE_NEW_SCOPE']);
    expect(result.decisions[0]).toMatchObject({
      disposition: 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK',
      gate: 'POLICY_REVIEW_REQUIRED',
    });
  });
});
