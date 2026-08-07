import {
  persistSignedRestorePrivacyEffectRecord,
  RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION,
  type AbortedRestorePrivacyEffectRecord,
  type CommittedRestorePrivacyEffectRecord,
  type PendingRestorePrivacyEffectRecord,
  type RestorePrivacyEffectIdentity,
  type RestorePrivacyEffectRecord,
} from '@masters/db';

export interface AthleteAnonymizationPrivacyEffectJournal {
  persist(record: Readonly<RestorePrivacyEffectRecord>): Promise<void>;
}

export interface FileSystemAthleteAnonymizationPrivacyEffectJournalConfig {
  targetDir: string;
  keyFile: string;
}

function requiredPath(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required for irreversible anonymization`);
  return normalized;
}

export function createFileSystemAthleteAnonymizationPrivacyEffectJournal(
  config: Readonly<FileSystemAthleteAnonymizationPrivacyEffectJournalConfig>,
): AthleteAnonymizationPrivacyEffectJournal {
  const targetDir = requiredPath(config.targetDir, 'Restore privacy effect journal directory');
  const keyFile = requiredPath(config.keyFile, 'Restore privacy effect journal signing key file');
  return Object.freeze({
    async persist(record: Readonly<RestorePrivacyEffectRecord>): Promise<void> {
      await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record });
    },
  });
}

export function configuredAthleteAnonymizationPrivacyEffectJournal(
  env: NodeJS.ProcessEnv = process.env,
): AthleteAnonymizationPrivacyEffectJournal {
  return createFileSystemAthleteAnonymizationPrivacyEffectJournal({
    targetDir: requiredPath(
      env.RESTORE_PRIVACY_EFFECT_JOURNAL_DIR,
      'RESTORE_PRIVACY_EFFECT_JOURNAL_DIR',
    ),
    keyFile: requiredPath(
      env.RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE,
      'RESTORE_PRIVACY_EFFECT_JOURNAL_KEY_FILE',
    ),
  });
}

export function pendingAthleteAnonymizationPrivacyEffectRecord(
  effect: Readonly<RestorePrivacyEffectIdentity>,
  recordedAt: string,
): Readonly<PendingRestorePrivacyEffectRecord> {
  return Object.freeze({
    journalVersion: RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION,
    phase: 'PENDING',
    recordedAt,
    effect,
  });
}

export function committedAthleteAnonymizationPrivacyEffectRecord(
  effect: Readonly<RestorePrivacyEffectIdentity>,
  dbCommittedAt: string,
): Readonly<CommittedRestorePrivacyEffectRecord> {
  return Object.freeze({
    journalVersion: RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION,
    phase: 'COMMITTED',
    recordedAt: dbCommittedAt,
    dbCommittedAt,
    effect,
  });
}

export function abortedAthleteAnonymizationPrivacyEffectRecord(
  effect: Readonly<RestorePrivacyEffectIdentity>,
  abortedAt: string,
): Readonly<AbortedRestorePrivacyEffectRecord> {
  return Object.freeze({
    journalVersion: RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION,
    phase: 'ABORTED',
    recordedAt: abortedAt,
    effect,
  });
}
