import { describe, expect, it } from 'vitest';
import {
  attestGlobalPrivacyCapabilitiesFromEnvironment,
  BACKUP_PRIVACY_POLICY_VERSION,
  GLOBAL_PRIVACY_ENV,
  NOTIFICATION_PRIVACY_POLICY_VERSION,
  resolveGlobalPrivacyCapabilitiesFromEnvironment,
} from '../src';

function completeEnabledEnvironment(): Record<string, string> {
  return {
    [GLOBAL_PRIVACY_ENV.backupState]: 'ENABLED',
    [GLOBAL_PRIVACY_ENV.backupPolicyVersion]: BACKUP_PRIVACY_POLICY_VERSION,
    [GLOBAL_PRIVACY_ENV.backupEncryptedAtRest]: 'true',
    [GLOBAL_PRIVACY_ENV.backupBoundedRetention]: 'true',
    [GLOBAL_PRIVACY_ENV.backupRestoreReconciliation]: 'true',
    [GLOBAL_PRIVACY_ENV.notificationState]: 'ENABLED',
    [GLOBAL_PRIVACY_ENV.notificationPolicyVersion]: NOTIFICATION_PRIVACY_POLICY_VERSION,
    [GLOBAL_PRIVACY_ENV.notificationSubjectScope]: 'true',
    [GLOBAL_PRIVACY_ENV.notificationDirectIdentifiersForbidden]: 'true',
    [GLOBAL_PRIVACY_ENV.notificationSubjectCleanup]: 'true',
  };
}

describe('runtime global privacy capability attestation', () => {
  it('fails closed when neither capability is declared', () => {
    const attestation = attestGlobalPrivacyCapabilitiesFromEnvironment({});
    expect(attestation.capabilities).toEqual({});
    expect(attestation.evaluation.readyForIrreversibleProcessing).toBe(false);
    expect(attestation.evaluation.blockers).toEqual([
      'BACKUP_CAPABILITY_STATE_REQUIRED',
      'NOTIFICATION_CAPABILITY_STATE_REQUIRED',
    ]);
  });

  it('accepts explicitly disabled capabilities without pretending enabled features exist', () => {
    const attestation = attestGlobalPrivacyCapabilitiesFromEnvironment({
      [GLOBAL_PRIVACY_ENV.backupState]: 'DISABLED',
      [GLOBAL_PRIVACY_ENV.notificationState]: 'DISABLED',
    });
    expect(attestation.capabilities).toEqual({
      backup: { state: 'DISABLED' },
      notifications: { state: 'DISABLED' },
    });
    expect(attestation.evaluation).toMatchObject({
      readyForIrreversibleProcessing: true,
      blockers: [],
    });
  });

  it('accepts only a complete versioned attestation for enabled capabilities', () => {
    const attestation = attestGlobalPrivacyCapabilitiesFromEnvironment(completeEnabledEnvironment());
    expect(attestation.evaluation).toMatchObject({
      readyForIrreversibleProcessing: true,
      backupPolicyVersion: BACKUP_PRIVACY_POLICY_VERSION,
      notificationPolicyVersion: NOTIFICATION_PRIVACY_POLICY_VERSION,
      blockers: [],
    });
  });

  it('reports versioned blockers for partial or stale enabled capability declarations', () => {
    const env = completeEnabledEnvironment();
    env[GLOBAL_PRIVACY_ENV.backupPolicyVersion] = '0.9.0';
    env[GLOBAL_PRIVACY_ENV.backupEncryptedAtRest] = 'false';
    delete env[GLOBAL_PRIVACY_ENV.notificationSubjectCleanup];

    const attestation = attestGlobalPrivacyCapabilitiesFromEnvironment(env);
    expect(attestation.evaluation.readyForIrreversibleProcessing).toBe(false);
    expect(attestation.evaluation.blockers).toEqual([
      'BACKUP_ENCRYPTION_REQUIRED',
      'BACKUP_POLICY_VERSION_MISMATCH',
      'NOTIFICATION_SUBJECT_CLEANUP_REQUIRED',
    ]);
  });

  it('rejects misspelled state and boolean values instead of coercing them', () => {
    expect(() => resolveGlobalPrivacyCapabilitiesFromEnvironment({
      [GLOBAL_PRIVACY_ENV.backupState]: 'enable',
    })).toThrow(/DISABLED or ENABLED/);
    expect(() => resolveGlobalPrivacyCapabilitiesFromEnvironment({
      [GLOBAL_PRIVACY_ENV.backupState]: 'ENABLED',
      [GLOBAL_PRIVACY_ENV.backupEncryptedAtRest]: 'yes',
    })).toThrow(/true or false/);
  });
});
