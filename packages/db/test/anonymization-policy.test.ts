import { describe, expect, it } from 'vitest';
import { evaluateAnonymizationPolicy } from '../src/services/anonymization-policy';

const scopes = [
  { scope: 'ATHLETE_PROFILE', disposition: 'DIRECT_IDENTIFIER_REDACTION_REQUIRED', rowCount: 1, references: [] },
  { scope: 'ATHLETE_SNAPSHOTS', disposition: 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', rowCount: 2, references: [] },
  { scope: 'TEST_PLAN_SNAPSHOTS', disposition: 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', rowCount: 1, references: [] },
  { scope: 'RELATIONSHIP_AND_PRIVACY_RECORDS', disposition: 'RELATIONSHIP_DATA_POLICY_REQUIRED', rowCount: 3, references: [] },
  { scope: 'DIAGNOSTIC_AND_OPERATIONAL_RECORDS', disposition: 'REIDENTIFICATION_RISK_REVIEW_REQUIRED', rowCount: 12, references: [] },
  { scope: 'REPORT_DATABASE_RECORDS', disposition: 'EXTERNAL_ARTIFACT_HANDLING_REQUIRED', rowCount: 2, references: ['reports/a.pdf'] },
  { scope: 'AUDIT_PRIVACY_CANDIDATES', disposition: 'AUDIT_PRIVACY_REDACTION_REQUIRED', rowCount: 1, references: ['audit-a'] },
  { scope: 'PRIOR_AUDIT_REDACTION_PROOFS', disposition: 'AUDIT_PRIVACY_REDACTION_REQUIRED', rowCount: 1, references: [] },
  { scope: 'ACTIVE_TENANT_EXPORT_PACKAGES', disposition: 'EPHEMERAL_EXPORT_CLEANUP_REQUIRED', rowCount: 1, references: ['exports/current.zip'] },
] as const;

describe('anonymization disposition policy v1', () => {
  it('remains fail-closed and distinguishes automatable scopes from unresolved policy scopes', () => {
    const result = evaluateAnonymizationPolicy(scopes, [
      'REPORT_STORAGE_VERIFICATION',
      'BACKUP_RETENTION_POLICY_REVIEW',
      'NOTIFICATION_PAYLOAD_REVIEW',
    ]);

    expect(result.policyVersion).toBe('1.0.0');
    expect(result.executionAllowed).toBe(false);
    expect(result.unresolvedScopes).toEqual([
      'ACTIVE_TENANT_EXPORT_PACKAGES',
      'DIAGNOSTIC_AND_OPERATIONAL_RECORDS',
      'RELATIONSHIP_AND_PRIVACY_RECORDS',
      'REPORT_DATABASE_RECORDS',
    ]);
    expect(result.blockers).toEqual([
      'ADMINISTRATIVE_APPROVAL_REQUIRED',
      'DIAGNOSTIC_REIDENTIFICATION_REVIEW_REQUIRED',
      'EXTERNAL_ARTIFACT_VERIFICATION_REQUIRED',
      'GLOBAL_RETENTION_AND_NOTIFICATION_REVIEW_REQUIRED',
      'RELATIONSHIP_POLICY_REVIEW_REQUIRED',
    ]);
    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'ATHLETE_PROFILE', disposition: 'REDACT_DIRECT_IDENTIFIERS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'ATHLETE_SNAPSHOTS', disposition: 'REWRITE_EMBEDDED_IDENTIFIERS', gate: 'AUTOMATABLE_AFTER_ADMIN_APPROVAL' }),
      expect.objectContaining({ scope: 'DIAGNOSTIC_AND_OPERATIONAL_RECORDS', disposition: 'REVIEW_DIAGNOSTIC_REIDENTIFICATION_RISK', gate: 'POLICY_REVIEW_REQUIRED' }),
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
