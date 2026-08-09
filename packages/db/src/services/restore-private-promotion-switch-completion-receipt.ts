import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type {
  SignedRestorePrivatePromotionSwitchExecutionEventEnvelope,
} from './restore-private-promotion-switch-execution';
import type { SignedRestorePrivatePromotionSwitchJournalEnvelope } from './restore-private-promotion-switch-journal';
import type { RestorePrivatePromotionSwitchRole } from './restore-private-promotion-switch-intent';

export const RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME = 'promotion-switch-completion-receipt.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-switch-completion-receipt:v1\n';
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface RestorePrivatePromotionPostSwitchHealthcheckVolume {
  readonly role: RestorePrivatePromotionSwitchRole;
  readonly volumeName: string;
}

export interface RestorePrivatePromotionPostSwitchHealthcheck {
  readonly mode: 'CLUB_RESTORE_PROMOTION_POST_SWITCH_HEALTHCHECK';
  readonly status: 'HEALTHY';
  readonly healthcheckVersion: 1;
  readonly checkedAt: string;
  readonly candidateSetId: string;
  readonly currentVolumeSet: 'CANDIDATE';
  readonly libsqlHealth: 'HEALTHY';
  readonly appHealth: 'HEALTHY';
  readonly exportCleanupRunning: true;
  readonly retentionScanRunning: true;
  readonly caddyPreserved: true;
  readonly rollbackVolumesRetained: true;
  readonly candidateVolumes: readonly Readonly<RestorePrivatePromotionPostSwitchHealthcheckVolume>[];
}

export interface RestorePrivatePromotionSwitchCompletionReceiptRecord {
  readonly receiptVersion: typeof RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_VERSION;
  readonly status: 'PROMOTED';
  readonly completedAt: string;
  readonly journalFingerprint: `sha256:${string}`;
  readonly journalSignature: `hmac-sha256:${string}`;
  readonly candidateSetId: string;
  readonly candidateSetFingerprint: `sha256:${string}`;
  readonly candidateSelectedEventSignature: `hmac-sha256:${string}`;
  readonly postSwitchHealthcheckVersion: 1;
  readonly postSwitchHealthcheckFingerprint: `sha256:${string}`;
  readonly currentVolumeSet: 'CANDIDATE';
  readonly libsqlHealth: 'HEALTHY';
  readonly appHealth: 'HEALTHY';
  readonly exportCleanupRunning: true;
  readonly retentionScanRunning: true;
  readonly caddyPreserved: true;
  readonly rollbackVolumesRetained: true;
  readonly candidateVolumes: readonly Readonly<RestorePrivatePromotionPostSwitchHealthcheckVolume>[];
  readonly productionMutationCompleted: true;
  readonly promotionExecuted: true;
}

export interface SignedRestorePrivatePromotionSwitchCompletionReceiptEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionSwitchCompletionReceiptRecord>;
  readonly signature: `hmac-sha256:${string}`;
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

function assertTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_FINGERPRINT.test(value)) throw new Error(`${label} must be a sha256 fingerprint`);
}

function assertHmac(value: string, label: string): void {
  if (!HMAC_SHA256_SIGNATURE.test(value)) throw new Error(`${label} must be an HMAC-SHA256 signature`);
}

function assertVolumeName(value: string, label: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${label} is not a safe Docker volume name`);
}

function normalizedHealthcheckBody(
  healthcheck: Readonly<RestorePrivatePromotionPostSwitchHealthcheck>,
) {
  return {
    healthcheckVersion: healthcheck.healthcheckVersion,
    checkedAt: healthcheck.checkedAt,
    candidateSetId: healthcheck.candidateSetId,
    currentVolumeSet: healthcheck.currentVolumeSet,
    libsqlHealth: healthcheck.libsqlHealth,
    appHealth: healthcheck.appHealth,
    exportCleanupRunning: healthcheck.exportCleanupRunning,
    retentionScanRunning: healthcheck.retentionScanRunning,
    caddyPreserved: healthcheck.caddyPreserved,
    rollbackVolumesRetained: healthcheck.rollbackVolumesRetained,
    candidateVolumes: healthcheck.candidateVolumes.map((item) => ({ role: item.role, volumeName: item.volumeName })),
  };
}

function verifyHealthcheck(
  healthcheck: Readonly<RestorePrivatePromotionPostSwitchHealthcheck>,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
): void {
  if (
    healthcheck.mode !== 'CLUB_RESTORE_PROMOTION_POST_SWITCH_HEALTHCHECK'
    || healthcheck.status !== 'HEALTHY'
    || healthcheck.healthcheckVersion !== 1
    || healthcheck.currentVolumeSet !== 'CANDIDATE'
    || healthcheck.libsqlHealth !== 'HEALTHY'
    || healthcheck.appHealth !== 'HEALTHY'
    || healthcheck.exportCleanupRunning !== true
    || healthcheck.retentionScanRunning !== true
    || healthcheck.caddyPreserved !== true
    || healthcheck.rollbackVolumesRetained !== true
  ) {
    throw new Error('Restore promotion completion receipt requires a healthy post-switch report');
  }
  assertTimestamp(healthcheck.checkedAt, 'Post-switch healthcheck checkedAt');
  if (healthcheck.candidateSetId !== journal.record.candidateSetId) {
    throw new Error('Post-switch healthcheck candidate-set ID does not match durable journal');
  }
  if (healthcheck.candidateVolumes.length !== ROLE_ORDER.length) {
    throw new Error('Post-switch healthcheck must contain exactly four candidate volumes');
  }
  for (const [index, role] of ROLE_ORDER.entries()) {
    const observed = healthcheck.candidateVolumes[index];
    const expected = journal.record.volumes[index];
    if (!observed || observed.role !== role || !expected || expected.role !== role) {
      throw new Error('Post-switch healthcheck candidate volume order is invalid');
    }
    assertVolumeName(observed.volumeName, `Post-switch ${role} candidate volume`);
    if (observed.volumeName !== expected.candidateVolumeName) {
      throw new Error(`Post-switch ${role} volume does not match durable journal candidate`);
    }
  }
}

function requireCandidateSelectedEvent(
  events: readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[],
  allowCompleted: boolean,
): Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> {
  const candidateSelected = events.find((event) => event.record.phase === 'CANDIDATE_SELECTED');
  const last = events.at(-1);
  if (!candidateSelected || candidateSelected.record.targetVolumeSet !== 'CANDIDATE' || !last) {
    throw new Error('Restore promotion completion receipt requires CANDIDATE_SELECTED execution evidence');
  }
  if (last.record.phase !== 'CANDIDATE_SELECTED' && !(allowCompleted && last.record.phase === 'COMPLETED')) {
    throw new Error('Restore promotion completion receipt is incompatible with rollback or non-completion execution evidence');
  }
  assertHmac(candidateSelected.signature, 'Candidate-selected event signature');
  return candidateSelected;
}

function validateRecord(
  record: Readonly<RestorePrivatePromotionSwitchCompletionReceiptRecord>,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
  candidateSelected: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>,
): void {
  if (record.receiptVersion !== 1 || record.status !== 'PROMOTED') {
    throw new Error('Restore promotion completion receipt version or status is invalid');
  }
  assertTimestamp(record.completedAt, 'Restore promotion completion receipt completedAt');
  if (record.completedAt < candidateSelected.record.recordedAt) {
    throw new Error('Restore promotion completion receipt cannot predate candidate selection evidence');
  }
  assertSha256(record.journalFingerprint, 'Completion receipt journal fingerprint');
  assertHmac(record.journalSignature, 'Completion receipt journal signature');
  assertSha256(record.candidateSetFingerprint, 'Completion receipt candidate-set fingerprint');
  assertHmac(record.candidateSelectedEventSignature, 'Completion receipt candidate-selected event signature');
  assertSha256(record.postSwitchHealthcheckFingerprint, 'Completion receipt healthcheck fingerprint');
  if (
    record.journalFingerprint !== journal.record.journalFingerprint
    || record.journalSignature !== journal.signature
    || record.candidateSetId !== journal.record.candidateSetId
    || record.candidateSetFingerprint !== journal.record.candidateSetFingerprint
    || record.candidateSelectedEventSignature !== candidateSelected.signature
  ) {
    throw new Error('Restore promotion completion receipt does not match durable switch evidence');
  }
  if (
    record.postSwitchHealthcheckVersion !== 1
    || record.currentVolumeSet !== 'CANDIDATE'
    || record.libsqlHealth !== 'HEALTHY'
    || record.appHealth !== 'HEALTHY'
    || record.exportCleanupRunning !== true
    || record.retentionScanRunning !== true
    || record.caddyPreserved !== true
    || record.rollbackVolumesRetained !== true
    || record.productionMutationCompleted !== true
    || record.promotionExecuted !== true
  ) {
    throw new Error('Restore promotion completion receipt safety state is invalid');
  }
  if (record.candidateVolumes.length !== 4) throw new Error('Completion receipt must contain four candidate volumes');
  for (const [index, role] of ROLE_ORDER.entries()) {
    const volume = record.candidateVolumes[index];
    const journalVolume = journal.record.volumes[index];
    if (!volume || volume.role !== role || !journalVolume || volume.volumeName !== journalVolume.candidateVolumeName) {
      throw new Error('Completion receipt candidate volume binding is invalid');
    }
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion completion receipt key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore promotion completion receipt key must be a regular file');
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Restore promotion completion receipt key must decode to exactly 32 bytes');
  return key;
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionSwitchCompletionReceiptRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({ envelopeVersion: 1, record })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivatePromotionSwitchCompletionReceiptRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

export function createRestorePrivatePromotionSwitchCompletionReceiptRecord(
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
  events: readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[],
  healthcheck: Readonly<RestorePrivatePromotionPostSwitchHealthcheck>,
  completedAt: string,
): Readonly<RestorePrivatePromotionSwitchCompletionReceiptRecord> {
  const candidateSelected = requireCandidateSelectedEvent(events, false);
  verifyHealthcheck(healthcheck, journal);
  assertTimestamp(completedAt, 'Restore promotion completion receipt completedAt');
  const record = Object.freeze({
    receiptVersion: 1 as const,
    status: 'PROMOTED' as const,
    completedAt,
    journalFingerprint: journal.record.journalFingerprint,
    journalSignature: journal.signature,
    candidateSetId: journal.record.candidateSetId,
    candidateSetFingerprint: journal.record.candidateSetFingerprint,
    candidateSelectedEventSignature: candidateSelected.signature,
    postSwitchHealthcheckVersion: 1 as const,
    postSwitchHealthcheckFingerprint: sha256(JSON.stringify(normalizedHealthcheckBody(healthcheck))),
    currentVolumeSet: 'CANDIDATE' as const,
    libsqlHealth: 'HEALTHY' as const,
    appHealth: 'HEALTHY' as const,
    exportCleanupRunning: true as const,
    retentionScanRunning: true as const,
    caddyPreserved: true as const,
    rollbackVolumesRetained: true as const,
    candidateVolumes: Object.freeze(healthcheck.candidateVolumes.map((item) => Object.freeze({ role: item.role, volumeName: item.volumeName }))),
    productionMutationCompleted: true as const,
    promotionExecuted: true as const,
  });
  validateRecord(record, journal, candidateSelected);
  return record;
}

export async function readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(
  filePath: string,
  keyFile: string,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
  events: readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[],
): Promise<Readonly<SignedRestorePrivatePromotionSwitchCompletionReceiptEnvelope>> {
  if (!isAbsolute(filePath)) throw new Error('Restore promotion completion receipt path must be absolute');
  if (basename(filePath) !== RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME) {
    throw new Error('Restore promotion completion receipt file name is invalid');
  }
  const candidateSelected = requireCandidateSelectedEvent(events, true);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore promotion completion receipt must be a regular file');
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionSwitchCompletionReceiptEnvelope>;
  if (parsed.envelopeVersion !== 1 || !parsed.record || typeof parsed.signature !== 'string') {
    throw new Error('Restore promotion completion receipt envelope is invalid');
  }
  validateRecord(parsed.record, journal, candidateSelected);
  if (!HMAC_SHA256_SIGNATURE.test(parsed.signature)) throw new Error('Restore promotion completion receipt signature is invalid');
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore promotion completion receipt signature verification failed');
  }
  return Object.freeze({ envelopeVersion: 1, record: parsed.record, signature: parsed.signature });
}

export async function ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(
  targetDir: string,
  keyFile: string,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
  events: readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[],
  healthcheck: Readonly<RestorePrivatePromotionPostSwitchHealthcheck>,
  completedAt: string,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSwitchCompletionReceiptEnvelope }>> {
  if (!isAbsolute(targetDir)) throw new Error('Restore promotion completion receipt target directory must be absolute');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await chmod(targetDir, 0o700);
  const finalPath = join(targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(finalPath, keyFile, journal, events);
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
  const record = createRestorePrivatePromotionSwitchCompletionReceiptRecord(journal, events, healthcheck, completedAt);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({ envelopeVersion: 1 as const, record, signature: signRecord(key, record) });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_PROMOTION_SWITCH_COMPLETION_RECEIPT_FILE_NAME}.${randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const current = await readFile(finalPath, 'utf8').catch(() => null);
      if (current === serialized) return Object.freeze({ path: finalPath, created: false, envelope });
      throw new Error('Restore promotion completion receipt already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}