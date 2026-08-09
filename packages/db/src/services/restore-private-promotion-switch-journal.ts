import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type {
  RestorePrivatePromotionSwitchRole,
  SignedRestorePrivatePromotionSwitchIntentEnvelope,
} from './restore-private-promotion-switch-intent';

export const RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME = 'promotion-switch-journal.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-switch-journal:v1\n';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface RestorePrivatePromotionSwitchJournalVolume {
  readonly role: RestorePrivatePromotionSwitchRole;
  readonly candidateVolumeName: string;
  readonly rollbackVolumeName: string;
  readonly treeFingerprint: `sha256:${string}`;
}

export interface RestorePrivatePromotionSwitchJournalRecord {
  readonly journalVersion: typeof RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_VERSION;
  readonly phase: 'PENDING';
  readonly startedAt: string;
  readonly switchIntentSignature: `hmac-sha256:${string}`;
  readonly switchAuthorizedAt: string;
  readonly candidateSetFingerprint: `sha256:${string}`;
  readonly planFingerprint: `sha256:${string}`;
  readonly activeVolumeSetFingerprint: `sha256:${string}`;
  readonly candidateSetId: string;
  readonly selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1';
  readonly selectorOverride: 'infra/docker-compose.restore-promotion-selector.yml';
  readonly rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES';
  readonly caddyPolicy: 'PRESERVE_CURRENT';
  readonly crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION';
  readonly rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER';
  readonly completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK';
  readonly journalPersistenceScope: 'HOST_DURABLE_OUTSIDE_RESTORE_WORKSPACE';
  readonly journalRequiredBeforeMutation: true;
  readonly rollbackVolumesMustRemain: true;
  readonly productionSwitchAuthorized: true;
  readonly productionMutationStarted: false;
  readonly promotionExecuted: false;
  readonly volumes: readonly Readonly<RestorePrivatePromotionSwitchJournalVolume>[];
  readonly journalFingerprint: `sha256:${string}`;
}

export interface SignedRestorePrivatePromotionSwitchJournalEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionSwitchJournalRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface EnsureRestorePrivatePromotionSwitchJournalInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly switchIntent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>;
  readonly startedAt: string;
}

const ROLE_ORDER: readonly RestorePrivatePromotionSwitchRole[] = Object.freeze([
  'LIBSQL',
  'REPORTS',
  'TENANT_EXPORTS',
  'DATA_SUBJECT_DELIVERY',
]);

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!SHA256_FINGERPRINT.test(value)) throw new Error(`${label} must be a sha256 fingerprint`);
}

function assertHmac(value: string, label: string): asserts value is `hmac-sha256:${string}` {
  if (!HMAC_SHA256_SIGNATURE.test(value)) throw new Error(`${label} must be an HMAC-SHA256 signature`);
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertDockerVolumeName(value: string, label: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${label} is not a safe Docker volume name`);
}

function verifySwitchIntent(intent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>): void {
  if (intent.envelopeVersion !== 1) throw new Error('Restore promotion switch journal requires switch intent envelope v1');
  assertHmac(intent.signature, 'Restore promotion switch intent signature');
  const record = intent.record;
  if (
    record.switchIntentVersion !== 1
    || record.phase !== 'PENDING'
    || record.selectorStrategy !== 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1'
    || record.rollbackStrategy !== 'KEEP_PREVIOUS_ACTIVE_VOLUMES'
    || record.caddyPolicy !== 'PRESERVE_CURRENT'
    || record.crashRecoveryPolicy !== 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION'
    || record.rollbackPolicy !== 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER'
    || record.completionPolicy !== 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK'
    || record.preSwitchHealthcheckRequired !== true
    || record.rollbackVolumesMustRemain !== true
    || record.productionSwitchAuthorized !== true
    || record.promotionExecuted !== false
  ) {
    throw new Error('Restore promotion switch intent is not eligible for durable journal preparation');
  }
  assertCanonicalTimestamp(record.authorizedAt, 'Restore promotion switch authorization time');
  assertSha256(record.candidateSetFingerprint, 'Restore promotion switch candidate-set fingerprint');
  assertSha256(record.planFingerprint, 'Restore promotion switch plan fingerprint');
  assertSha256(record.activeVolumeSetFingerprint, 'Restore promotion switch active-volume fingerprint');
  if (!/^restore-[0-9a-f]{20}$/.test(record.candidateSetId)) {
    throw new Error('Restore promotion switch candidate-set ID is invalid');
  }
  if (record.volumes.length !== ROLE_ORDER.length) {
    throw new Error('Restore promotion switch intent must contain exactly four volume roles');
  }
  const candidates = new Set<string>();
  const rollbacks = new Set<string>();
  for (const [index, role] of ROLE_ORDER.entries()) {
    const volume = record.volumes[index];
    if (!volume || volume.role !== role) throw new Error('Restore promotion switch intent volume order is invalid');
    assertDockerVolumeName(volume.candidateVolumeName, `Switch candidate ${role} volume`);
    assertDockerVolumeName(volume.rollbackVolumeName, `Switch rollback ${role} volume`);
    assertSha256(volume.treeFingerprint, `Switch ${role} tree fingerprint`);
    if (volume.candidateVolumeName === volume.rollbackVolumeName) {
      throw new Error('Restore promotion switch candidate and rollback volumes must differ');
    }
    candidates.add(volume.candidateVolumeName);
    rollbacks.add(volume.rollbackVolumeName);
  }
  if (candidates.size !== 4 || rollbacks.size !== 4 || [...candidates].some((name) => rollbacks.has(name))) {
    throw new Error('Restore promotion switch candidate and rollback volume sets are invalid');
  }
}

function journalBody(record: Omit<RestorePrivatePromotionSwitchJournalRecord, 'journalFingerprint'>) {
  return {
    journalVersion: record.journalVersion,
    phase: record.phase,
    startedAt: record.startedAt,
    switchIntentSignature: record.switchIntentSignature,
    switchAuthorizedAt: record.switchAuthorizedAt,
    candidateSetFingerprint: record.candidateSetFingerprint,
    planFingerprint: record.planFingerprint,
    activeVolumeSetFingerprint: record.activeVolumeSetFingerprint,
    candidateSetId: record.candidateSetId,
    selectorStrategy: record.selectorStrategy,
    selectorOverride: record.selectorOverride,
    rollbackStrategy: record.rollbackStrategy,
    caddyPolicy: record.caddyPolicy,
    crashRecoveryPolicy: record.crashRecoveryPolicy,
    rollbackPolicy: record.rollbackPolicy,
    completionPolicy: record.completionPolicy,
    journalPersistenceScope: record.journalPersistenceScope,
    journalRequiredBeforeMutation: record.journalRequiredBeforeMutation,
    rollbackVolumesMustRemain: record.rollbackVolumesMustRemain,
    productionSwitchAuthorized: record.productionSwitchAuthorized,
    productionMutationStarted: record.productionMutationStarted,
    promotionExecuted: record.promotionExecuted,
    volumes: record.volumes.map((item) => ({ ...item })),
  };
}

function computeJournalFingerprint(
  record: Omit<RestorePrivatePromotionSwitchJournalRecord, 'journalFingerprint'>,
): `sha256:${string}` {
  return sha256(JSON.stringify(journalBody(record)));
}

function validateRecord(record: Readonly<RestorePrivatePromotionSwitchJournalRecord>): void {
  if (record.journalVersion !== 1 || record.phase !== 'PENDING') {
    throw new Error('Restore promotion switch journal version or phase is invalid');
  }
  assertCanonicalTimestamp(record.startedAt, 'Restore promotion switch journal startedAt');
  assertCanonicalTimestamp(record.switchAuthorizedAt, 'Restore promotion switch journal switchAuthorizedAt');
  if (record.startedAt < record.switchAuthorizedAt) {
    throw new Error('Restore promotion switch journal cannot start before switch authorization');
  }
  assertHmac(record.switchIntentSignature, 'Restore promotion switch journal intent signature');
  assertSha256(record.candidateSetFingerprint, 'Restore promotion switch journal candidate-set fingerprint');
  assertSha256(record.planFingerprint, 'Restore promotion switch journal plan fingerprint');
  assertSha256(record.activeVolumeSetFingerprint, 'Restore promotion switch journal active-volume fingerprint');
  assertSha256(record.journalFingerprint, 'Restore promotion switch journal fingerprint');
  if (!/^restore-[0-9a-f]{20}$/.test(record.candidateSetId)) {
    throw new Error('Restore promotion switch journal candidate-set ID is invalid');
  }
  if (
    record.selectorStrategy !== 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1'
    || record.selectorOverride !== 'infra/docker-compose.restore-promotion-selector.yml'
    || record.rollbackStrategy !== 'KEEP_PREVIOUS_ACTIVE_VOLUMES'
    || record.caddyPolicy !== 'PRESERVE_CURRENT'
    || record.crashRecoveryPolicy !== 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION'
    || record.rollbackPolicy !== 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER'
    || record.completionPolicy !== 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK'
    || record.journalPersistenceScope !== 'HOST_DURABLE_OUTSIDE_RESTORE_WORKSPACE'
    || record.journalRequiredBeforeMutation !== true
    || record.rollbackVolumesMustRemain !== true
    || record.productionSwitchAuthorized !== true
    || record.productionMutationStarted !== false
    || record.promotionExecuted !== false
  ) {
    throw new Error('Restore promotion switch journal safety policy is invalid');
  }
  if (record.volumes.length !== ROLE_ORDER.length) {
    throw new Error('Restore promotion switch journal must contain exactly four volume roles');
  }
  const candidates = new Set<string>();
  const rollbacks = new Set<string>();
  for (const [index, role] of ROLE_ORDER.entries()) {
    const volume = record.volumes[index];
    if (!volume || volume.role !== role) throw new Error('Restore promotion switch journal volume order is invalid');
    assertDockerVolumeName(volume.candidateVolumeName, `Journal candidate ${role} volume`);
    assertDockerVolumeName(volume.rollbackVolumeName, `Journal rollback ${role} volume`);
    assertSha256(volume.treeFingerprint, `Journal ${role} tree fingerprint`);
    if (volume.candidateVolumeName === volume.rollbackVolumeName) {
      throw new Error('Restore promotion switch journal candidate and rollback volumes must differ');
    }
    candidates.add(volume.candidateVolumeName);
    rollbacks.add(volume.rollbackVolumeName);
  }
  if (candidates.size !== 4 || rollbacks.size !== 4 || [...candidates].some((name) => rollbacks.has(name))) {
    throw new Error('Restore promotion switch journal volume sets are invalid');
  }
  const { journalFingerprint: _ignored, ...withoutFingerprint } = record;
  if (computeJournalFingerprint(withoutFingerprint) !== record.journalFingerprint) {
    throw new Error('Restore promotion switch journal fingerprint does not match content');
  }
}

function assertIntentBinding(
  record: Readonly<RestorePrivatePromotionSwitchJournalRecord>,
  intent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>,
): void {
  verifySwitchIntent(intent);
  if (
    record.switchIntentSignature !== intent.signature
    || record.switchAuthorizedAt !== intent.record.authorizedAt
    || record.candidateSetFingerprint !== intent.record.candidateSetFingerprint
    || record.planFingerprint !== intent.record.planFingerprint
    || record.activeVolumeSetFingerprint !== intent.record.activeVolumeSetFingerprint
    || record.candidateSetId !== intent.record.candidateSetId
    || record.selectorStrategy !== intent.record.selectorStrategy
    || record.rollbackStrategy !== intent.record.rollbackStrategy
    || record.caddyPolicy !== intent.record.caddyPolicy
    || record.crashRecoveryPolicy !== intent.record.crashRecoveryPolicy
    || record.rollbackPolicy !== intent.record.rollbackPolicy
    || record.completionPolicy !== intent.record.completionPolicy
    || record.rollbackVolumesMustRemain !== intent.record.rollbackVolumesMustRemain
    || record.productionSwitchAuthorized !== intent.record.productionSwitchAuthorized
  ) {
    throw new Error('Restore promotion switch journal does not match signed switch intent');
  }
  for (const [index, source] of intent.record.volumes.entries()) {
    const bound = record.volumes[index];
    if (
      !bound
      || bound.role !== source.role
      || bound.candidateVolumeName !== source.candidateVolumeName
      || bound.rollbackVolumeName !== source.rollbackVolumeName
      || bound.treeFingerprint !== source.treeFingerprint
    ) {
      throw new Error('Restore promotion switch journal volume binding does not match signed switch intent');
    }
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion switch journal key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch journal key must be a regular non-symlink file');
  }
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Restore promotion switch journal key must decode to exactly 32 bytes');
  return key;
}

async function ensureTargetDirectory(targetDir: string): Promise<void> {
  if (!isAbsolute(targetDir)) throw new Error('Restore promotion switch journal target directory must be absolute');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(targetDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch journal target must be a non-symlink directory');
  }
  await chmod(targetDir, 0o700);
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionSwitchJournalRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivatePromotionSwitchJournalRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

export function createRestorePrivatePromotionSwitchJournalRecord(
  intent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>,
  startedAt: string,
): Readonly<RestorePrivatePromotionSwitchJournalRecord> {
  verifySwitchIntent(intent);
  assertCanonicalTimestamp(startedAt, 'Restore promotion switch journal startedAt');
  if (startedAt < intent.record.authorizedAt) {
    throw new Error('Restore promotion switch journal cannot start before switch authorization');
  }
  const withoutFingerprint = Object.freeze({
    journalVersion: RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_VERSION,
    phase: 'PENDING' as const,
    startedAt,
    switchIntentSignature: intent.signature,
    switchAuthorizedAt: intent.record.authorizedAt,
    candidateSetFingerprint: intent.record.candidateSetFingerprint,
    planFingerprint: intent.record.planFingerprint,
    activeVolumeSetFingerprint: intent.record.activeVolumeSetFingerprint,
    candidateSetId: intent.record.candidateSetId,
    selectorStrategy: intent.record.selectorStrategy,
    selectorOverride: 'infra/docker-compose.restore-promotion-selector.yml' as const,
    rollbackStrategy: intent.record.rollbackStrategy,
    caddyPolicy: intent.record.caddyPolicy,
    crashRecoveryPolicy: intent.record.crashRecoveryPolicy,
    rollbackPolicy: intent.record.rollbackPolicy,
    completionPolicy: intent.record.completionPolicy,
    journalPersistenceScope: 'HOST_DURABLE_OUTSIDE_RESTORE_WORKSPACE' as const,
    journalRequiredBeforeMutation: true as const,
    rollbackVolumesMustRemain: true as const,
    productionSwitchAuthorized: true as const,
    productionMutationStarted: false as const,
    promotionExecuted: false as const,
    volumes: Object.freeze(intent.record.volumes.map((item) => Object.freeze({
      role: item.role,
      candidateVolumeName: item.candidateVolumeName,
      rollbackVolumeName: item.rollbackVolumeName,
      treeFingerprint: item.treeFingerprint,
    }))),
  });
  const record = Object.freeze({
    ...withoutFingerprint,
    journalFingerprint: computeJournalFingerprint(withoutFingerprint),
  });
  validateRecord(record);
  assertIntentBinding(record, intent);
  return record;
}

export async function readVerifiedRestorePrivatePromotionSwitchJournal(
  filePath: string,
  keyFile: string,
  intent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>,
): Promise<Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>> {
  if (!isAbsolute(filePath)) throw new Error('Restore promotion switch journal path must be absolute');
  if (basename(filePath) !== RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME) {
    throw new Error('Restore promotion switch journal file name is invalid');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch journal must be a regular non-symlink file');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionSwitchJournalEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore promotion switch journal envelope version is invalid');
  }
  validateRecord(parsed.record);
  assertIntentBinding(parsed.record, intent);
  if (typeof parsed.signature !== 'string' || !HMAC_SHA256_SIGNATURE.test(parsed.signature)) {
    throw new Error('Restore promotion switch journal signature is invalid');
  }
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore promotion switch journal signature verification failed');
  }
  return Object.freeze({ envelopeVersion: parsed.envelopeVersion, record: parsed.record, signature: parsed.signature });
}

export async function persistSignedRestorePrivatePromotionSwitchJournal(
  targetDir: string,
  keyFile: string,
  record: Readonly<RestorePrivatePromotionSwitchJournalRecord>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSwitchJournalEnvelope }>> {
  validateRecord(record);
  await ensureTargetDirectory(targetDir);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_ENVELOPE_VERSION,
    record,
    signature: signRecord(key, record),
  }) satisfies SignedRestorePrivatePromotionSwitchJournalEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME);
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME}.${randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readFile(finalPath, 'utf8').catch(() => null);
      if (existing === serialized) return Object.freeze({ path: finalPath, created: false, envelope });
      throw new Error('Restore promotion switch journal already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function ensureSignedRestorePrivatePromotionSwitchJournal(
  input: Readonly<EnsureRestorePrivatePromotionSwitchJournalInput>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSwitchJournalEnvelope }>> {
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivatePromotionSwitchJournal(
      finalPath,
      input.keyFile,
      input.switchIntent,
    );
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
  const record = createRestorePrivatePromotionSwitchJournalRecord(input.switchIntent, input.startedAt);
  try {
    return await persistSignedRestorePrivatePromotionSwitchJournal(input.targetDir, input.keyFile, record);
  } catch (error) {
    const existing = await readVerifiedRestorePrivatePromotionSwitchJournal(
      finalPath,
      input.keyFile,
      input.switchIntent,
    ).catch(() => null);
    if (existing) return Object.freeze({ path: finalPath, created: false, envelope: existing });
    throw error;
  }
}
