import { describe, expect, it } from 'vitest';
import {
  BACKUP_PRIVACY_POLICY_VERSION,
  NOTIFICATION_PRIVACY_POLICY_VERSION,
  evaluateGlobalPrivacyCapabilities,
} from '../src/services/global-privacy-policy';

describe('global privacy capability contract', () => {
  it('fails closed when runtime capability state is not explicitly declared', () => {
    const result = evaluateGlobalPrivacyCapabilities();
    expect(result.readyForIrreversibleProcessing).toBe(false);
    expect(result.blockers).toEqual([
      'BACKUP_CAPABILITY_STATE_REQUIRED',
      'NOTIFICATION_CAPABILITY_STATE_REQUIRED',
    ]);
  });

  it('accepts explicitly disabled global features without inventing unavailable data copies', () => {
    const result = evaluateGlobalPrivacyCapabilities({
      backup: { state: 'DISABLED' },
      notifications: { state: 'DISABLED' },
    });
    expect(result.readyForIrreversibleProcessing).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('requires the full versioned privacy contract when backup and notifications are enabled', () => {
    const result = evaluateGlobalPrivacyCapabilities({
      backup: {
        state: 'ENABLED',
        policyVersion: BACKUP_PRIVACY_POLICY_VERSION,
        encryptedAtRest: true,
        boundedRetentionConfigured: true,
        restorePrivacyReconciliation: true,
      },
      notifications: {
        state: 'ENABLED',
        policyVersion: NOTIFICATION_PRIVACY_POLICY_VERSION,
        subjectScopedPayloadContract: true,
        directIdentifiersForbidden: true,
        subjectCleanupSupported: true,
      },
    });
    expect(result.readyForIrreversibleProcessing).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('reports every missing enabled capability instead of partially approving', () => {
    const result = evaluateGlobalPrivacyCapabilities({
      backup: { state: 'ENABLED' },
      notifications: { state: 'ENABLED' },
    });
    expect(result.readyForIrreversibleProcessing).toBe(false);
    expect(result.blockers).toEqual([
      'BACKUP_BOUNDED_RETENTION_REQUIRED',
      'BACKUP_ENCRYPTION_REQUIRED',
      'BACKUP_POLICY_VERSION_MISMATCH',
      'BACKUP_RESTORE_PRIVACY_RECONCILIATION_REQUIRED',
      'NOTIFICATION_DIRECT_IDENTIFIER_PROHIBITION_REQUIRED',
      'NOTIFICATION_POLICY_VERSION_MISMATCH',
      'NOTIFICATION_SUBJECT_CLEANUP_REQUIRED',
      'NOTIFICATION_SUBJECT_SCOPE_REQUIRED',
    ]);
  });
});
