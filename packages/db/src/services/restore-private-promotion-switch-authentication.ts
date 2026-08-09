import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME,
  RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_VERSION,
  SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION,
  type RestorePrivatePromotionSwitchIntentRecord,
  type RestorePrivatePromotionSwitchRole,
  type SignedRestorePrivatePromotionSwitchIntentEnvelope,
} from './restore-private-promotion-switch-intent';

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-switch-intent:v1\n';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ROLE_ORDER: readonly RestorePrivatePromotionSwitchRole[] = Object.freeze([
  'LIBSQL',
  'REPORTS',
  'TENANT_EXPORTS',
  'DATA_SUBJECT_DELIVERY',
]);

function assertTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_FINGERPRINT.test(value)) throw new Error(`${label} must be a sha256 fingerprint`);
}

function assertVolumeName(value: string, label: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${label} is not a safe Docker volume name`);
}

export function validateAuthenticatedRestorePrivatePromotionSwitchIntentRecord(
  record: Readonly<RestorePrivatePromotionSwitchIntentRecord>,
): void {
  if (
    record.switchIntentVersion !== RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_VERSION
    || record.phase !== 'PENDING'
  ) {
    throw new Error('Authenticated restore promotion switch intent version or phase is invalid');
  }
  assertTimestamp(record.authorizedAt, 'Authenticated restore promotion switch intent authorizedAt');
  assertSha256(record.candidateSetFingerprint, 'Authenticated candidate-set fingerprint');
  assertSha256(record.planFingerprint, 'Authenticated execution-plan fingerprint');
  assertSha256(record.activeVolumeSetFingerprint, 'Authenticated rollback-volume-set fingerprint');
  if (!/^restore-[0-9a-f]{20}$/.test(record.candidateSetId)) {
    throw new Error('Authenticated restore promotion candidate-set ID is invalid');
  }
  if (
    record.candidateHealthcheckVersion !== 1
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
    throw new Error('Authenticated restore promotion switch intent safety policy is invalid');
  }
  if (record.volumes.length !== ROLE_ORDER.length) {
    throw new Error('Authenticated restore promotion switch intent must contain exactly four volume roles');
  }
  const candidates = new Set<string>();
  const rollbacks = new Set<string>();
  for (const [index, role] of ROLE_ORDER.entries()) {
    const volume = record.volumes[index];
    if (!volume || volume.role !== role) {
      throw new Error('Authenticated restore promotion switch intent volume order is invalid');
    }
    assertVolumeName(volume.candidateVolumeName, `Authenticated candidate ${role} volume`);
    assertVolumeName(volume.rollbackVolumeName, `Authenticated rollback ${role} volume`);
    assertSha256(volume.treeFingerprint, `Authenticated candidate ${role} tree fingerprint`);
    if (volume.candidateVolumeName === volume.rollbackVolumeName) {
      throw new Error('Authenticated restore promotion candidate and rollback volumes must differ');
    }
    candidates.add(volume.candidateVolumeName);
    rollbacks.add(volume.rollbackVolumeName);
  }
  if (
    candidates.size !== ROLE_ORDER.length
    || rollbacks.size !== ROLE_ORDER.length
    || [...candidates].some((name) => rollbacks.has(name))
  ) {
    throw new Error('Authenticated restore promotion switch volume sets are invalid');
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion switch authentication key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch authentication key must be a regular non-symlink file');
  }
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Restore promotion switch authentication key must decode to exactly 32 bytes');
  }
  return key;
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionSwitchIntentRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION,
    record,
  })}`;
}

function expectedSignature(
  key: Buffer,
  record: Readonly<RestorePrivatePromotionSwitchIntentRecord>,
): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

/**
 * Authenticates persisted switch intent without re-running the pre-cutover candidate-set healthcheck.
 * This is intentionally weaker than readVerifiedRestorePrivatePromotionSwitchIntent(): it proves
 * HMAC authenticity + immutable internal safety invariants, not that rollback volumes are still active.
 */
export async function readAuthenticatedRestorePrivatePromotionSwitchIntent(
  filePath: string,
  keyFile: string,
): Promise<Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>> {
  if (!isAbsolute(filePath)) throw new Error('Authenticated restore promotion switch intent path must be absolute');
  if (basename(filePath) !== RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME) {
    throw new Error('Authenticated restore promotion switch intent file name is invalid');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Authenticated restore promotion switch intent must be a regular non-symlink file');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionSwitchIntentEnvelope>;
  if (
    parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION
    || !parsed.record
  ) {
    throw new Error('Authenticated restore promotion switch intent envelope version is invalid');
  }
  validateAuthenticatedRestorePrivatePromotionSwitchIntentRecord(parsed.record);
  if (typeof parsed.signature !== 'string' || !HMAC_SHA256_SIGNATURE.test(parsed.signature)) {
    throw new Error('Authenticated restore promotion switch intent signature is invalid');
  }
  const key = await readSigningKey(keyFile);
  const expected = expectedSignature(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Authenticated restore promotion switch intent signature verification failed');
  }
  return Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION,
    record: parsed.record,
    signature: parsed.signature,
  });
}
