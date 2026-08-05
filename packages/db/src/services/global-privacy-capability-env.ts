import {
  BACKUP_PRIVACY_POLICY_VERSION,
  evaluateGlobalPrivacyCapabilities,
  NOTIFICATION_PRIVACY_POLICY_VERSION,
  type BackupPrivacyCapability,
  type GlobalPrivacyCapabilities,
  type GlobalPrivacyCapabilityEvaluation,
  type NotificationPrivacyCapability,
  type PrivacyCapabilityState,
} from './global-privacy-policy';

export const GLOBAL_PRIVACY_ENV = Object.freeze({
  backupState: 'PRIVACY_BACKUP_STATE',
  backupPolicyVersion: 'PRIVACY_BACKUP_POLICY_VERSION',
  backupEncryptedAtRest: 'PRIVACY_BACKUP_ENCRYPTED_AT_REST',
  backupBoundedRetention: 'PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED',
  backupRestoreReconciliation: 'PRIVACY_BACKUP_RESTORE_RECONCILIATION',
  notificationState: 'PRIVACY_NOTIFICATIONS_STATE',
  notificationPolicyVersion: 'PRIVACY_NOTIFICATIONS_POLICY_VERSION',
  notificationSubjectScope: 'PRIVACY_NOTIFICATIONS_SUBJECT_SCOPED_PAYLOAD',
  notificationDirectIdentifiersForbidden: 'PRIVACY_NOTIFICATIONS_DIRECT_IDENTIFIERS_FORBIDDEN',
  notificationSubjectCleanup: 'PRIVACY_NOTIFICATIONS_SUBJECT_CLEANUP_SUPPORTED',
} as const);

export interface GlobalPrivacyRuntimeAttestation {
  capabilities: Readonly<GlobalPrivacyCapabilities>;
  evaluation: Readonly<GlobalPrivacyCapabilityEvaluation>;
}

type Environment = Readonly<Record<string, string | undefined>>;

function optionalValue(env: Environment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function capabilityState(env: Environment, key: string): PrivacyCapabilityState | undefined {
  const raw = optionalValue(env, key);
  if (raw === undefined) return undefined;
  const normalized = raw.toUpperCase();
  if (normalized === 'DISABLED' || normalized === 'ENABLED') return normalized;
  throw new Error(`${key} must be DISABLED or ENABLED`);
}

function booleanValue(env: Environment, key: string): boolean | undefined {
  const raw = optionalValue(env, key);
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

function backupCapability(env: Environment): BackupPrivacyCapability | undefined {
  const state = capabilityState(env, GLOBAL_PRIVACY_ENV.backupState);
  if (state === undefined) return undefined;
  if (state === 'DISABLED') return Object.freeze({ state });

  const policyVersion = optionalValue(env, GLOBAL_PRIVACY_ENV.backupPolicyVersion);
  const encryptedAtRest = booleanValue(env, GLOBAL_PRIVACY_ENV.backupEncryptedAtRest);
  const boundedRetentionConfigured = booleanValue(env, GLOBAL_PRIVACY_ENV.backupBoundedRetention);
  const restorePrivacyReconciliation = booleanValue(env, GLOBAL_PRIVACY_ENV.backupRestoreReconciliation);
  return Object.freeze({
    state,
    ...(policyVersion === undefined
      ? {}
      : { policyVersion: policyVersion as typeof BACKUP_PRIVACY_POLICY_VERSION }),
    ...(encryptedAtRest === undefined ? {} : { encryptedAtRest }),
    ...(boundedRetentionConfigured === undefined ? {} : { boundedRetentionConfigured }),
    ...(restorePrivacyReconciliation === undefined ? {} : { restorePrivacyReconciliation }),
  });
}

function notificationCapability(env: Environment): NotificationPrivacyCapability | undefined {
  const state = capabilityState(env, GLOBAL_PRIVACY_ENV.notificationState);
  if (state === undefined) return undefined;
  if (state === 'DISABLED') return Object.freeze({ state });

  const policyVersion = optionalValue(env, GLOBAL_PRIVACY_ENV.notificationPolicyVersion);
  const subjectScopedPayloadContract = booleanValue(env, GLOBAL_PRIVACY_ENV.notificationSubjectScope);
  const directIdentifiersForbidden = booleanValue(
    env,
    GLOBAL_PRIVACY_ENV.notificationDirectIdentifiersForbidden,
  );
  const subjectCleanupSupported = booleanValue(env, GLOBAL_PRIVACY_ENV.notificationSubjectCleanup);
  return Object.freeze({
    state,
    ...(policyVersion === undefined
      ? {}
      : { policyVersion: policyVersion as typeof NOTIFICATION_PRIVACY_POLICY_VERSION }),
    ...(subjectScopedPayloadContract === undefined ? {} : { subjectScopedPayloadContract }),
    ...(directIdentifiersForbidden === undefined ? {} : { directIdentifiersForbidden }),
    ...(subjectCleanupSupported === undefined ? {} : { subjectCleanupSupported }),
  });
}

/**
 * Resolves explicit environment declarations into the versioned runtime privacy
 * capability contract. Unknown enum/boolean values are configuration errors;
 * missing declarations stay missing so evaluation remains fail-closed.
 */
export function resolveGlobalPrivacyCapabilitiesFromEnvironment(
  env: Environment,
): Readonly<GlobalPrivacyCapabilities> {
  const backup = backupCapability(env);
  const notifications = notificationCapability(env);
  return Object.freeze({
    ...(backup === undefined ? {} : { backup }),
    ...(notifications === undefined ? {} : { notifications }),
  });
}

export function attestGlobalPrivacyCapabilitiesFromEnvironment(
  env: Environment,
): Readonly<GlobalPrivacyRuntimeAttestation> {
  const capabilities = resolveGlobalPrivacyCapabilitiesFromEnvironment(env);
  return Object.freeze({
    capabilities,
    evaluation: evaluateGlobalPrivacyCapabilities(capabilities),
  });
}
