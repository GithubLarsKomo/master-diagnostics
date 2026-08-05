export const BACKUP_PRIVACY_POLICY_VERSION = '1.0.0' as const;
export const NOTIFICATION_PRIVACY_POLICY_VERSION = '1.0.0' as const;

export type PrivacyCapabilityState = 'DISABLED' | 'ENABLED';

export interface BackupPrivacyCapability {
  state: PrivacyCapabilityState;
  policyVersion?: typeof BACKUP_PRIVACY_POLICY_VERSION;
  encryptedAtRest?: boolean;
  boundedRetentionConfigured?: boolean;
  restorePrivacyReconciliation?: boolean;
}

export interface NotificationPrivacyCapability {
  state: PrivacyCapabilityState;
  policyVersion?: typeof NOTIFICATION_PRIVACY_POLICY_VERSION;
  subjectScopedPayloadContract?: boolean;
  directIdentifiersForbidden?: boolean;
  subjectCleanupSupported?: boolean;
}

export interface GlobalPrivacyCapabilities {
  backup?: BackupPrivacyCapability;
  notifications?: NotificationPrivacyCapability;
}

export type GlobalPrivacyCapabilityBlocker =
  | 'BACKUP_CAPABILITY_STATE_REQUIRED'
  | 'BACKUP_POLICY_VERSION_MISMATCH'
  | 'BACKUP_ENCRYPTION_REQUIRED'
  | 'BACKUP_BOUNDED_RETENTION_REQUIRED'
  | 'BACKUP_RESTORE_PRIVACY_RECONCILIATION_REQUIRED'
  | 'NOTIFICATION_CAPABILITY_STATE_REQUIRED'
  | 'NOTIFICATION_POLICY_VERSION_MISMATCH'
  | 'NOTIFICATION_SUBJECT_SCOPE_REQUIRED'
  | 'NOTIFICATION_DIRECT_IDENTIFIER_PROHIBITION_REQUIRED'
  | 'NOTIFICATION_SUBJECT_CLEANUP_REQUIRED';

export interface GlobalPrivacyCapabilityEvaluation {
  readyForIrreversibleProcessing: boolean;
  backupPolicyVersion: typeof BACKUP_PRIVACY_POLICY_VERSION;
  notificationPolicyVersion: typeof NOTIFICATION_PRIVACY_POLICY_VERSION;
  blockers: ReadonlyArray<GlobalPrivacyCapabilityBlocker>;
}

/**
 * Fail-closed runtime capability contract for global privacy surfaces that
 * cannot be proven from one athlete's database rows alone.
 *
 * A feature may explicitly declare itself DISABLED. When ENABLED, every
 * capability required by the versioned contract must be attested. Missing
 * declarations are deliberately different from DISABLED and remain blocking.
 */
export function evaluateGlobalPrivacyCapabilities(
  capabilities?: Readonly<GlobalPrivacyCapabilities>,
): Readonly<GlobalPrivacyCapabilityEvaluation> {
  const blockers: GlobalPrivacyCapabilityBlocker[] = [];
  const backup = capabilities?.backup;
  if (!backup) {
    blockers.push('BACKUP_CAPABILITY_STATE_REQUIRED');
  } else if (backup.state === 'ENABLED') {
    if (backup.policyVersion !== BACKUP_PRIVACY_POLICY_VERSION) {
      blockers.push('BACKUP_POLICY_VERSION_MISMATCH');
    }
    if (backup.encryptedAtRest !== true) blockers.push('BACKUP_ENCRYPTION_REQUIRED');
    if (backup.boundedRetentionConfigured !== true) blockers.push('BACKUP_BOUNDED_RETENTION_REQUIRED');
    if (backup.restorePrivacyReconciliation !== true) {
      blockers.push('BACKUP_RESTORE_PRIVACY_RECONCILIATION_REQUIRED');
    }
  }

  const notifications = capabilities?.notifications;
  if (!notifications) {
    blockers.push('NOTIFICATION_CAPABILITY_STATE_REQUIRED');
  } else if (notifications.state === 'ENABLED') {
    if (notifications.policyVersion !== NOTIFICATION_PRIVACY_POLICY_VERSION) {
      blockers.push('NOTIFICATION_POLICY_VERSION_MISMATCH');
    }
    if (notifications.subjectScopedPayloadContract !== true) {
      blockers.push('NOTIFICATION_SUBJECT_SCOPE_REQUIRED');
    }
    if (notifications.directIdentifiersForbidden !== true) {
      blockers.push('NOTIFICATION_DIRECT_IDENTIFIER_PROHIBITION_REQUIRED');
    }
    if (notifications.subjectCleanupSupported !== true) {
      blockers.push('NOTIFICATION_SUBJECT_CLEANUP_REQUIRED');
    }
  }

  return Object.freeze({
    readyForIrreversibleProcessing: blockers.length === 0,
    backupPolicyVersion: BACKUP_PRIVACY_POLICY_VERSION,
    notificationPolicyVersion: NOTIFICATION_PRIVACY_POLICY_VERSION,
    blockers: Object.freeze([...blockers].sort()),
  });
}
