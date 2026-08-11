import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import {
  readVerifiedRestoreSourceProvenance,
  type SignedRestoreSourceProvenanceEnvelope,
} from './backup-restore-source-provenance';
import {
  readAuthenticatedRestorePrivatePromotionSwitchIntent,
} from './restore-private-promotion-switch-authentication';
import type { SignedRestorePrivatePromotionSwitchIntentEnvelope } from './restore-private-promotion-switch-intent';

export const RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_FILE_NAME = 'promotion-source-provenance-binding.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-source-provenance-binding:v1\n';
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAGING_NAME_PATTERN = /^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RestorePrivatePromotionSourceProvenanceIdentity {
  readonly stagingName: string;
  readonly sourceProvenanceSignature: `hmac-sha256:${string}`;
  readonly backupFileName: string;
  readonly backupSha256: `sha256:${string}`;
  readonly backupCreatedAt: string;
  readonly backupManifestFingerprint: `sha256:${string}`;
}

export interface RestorePrivatePromotionSourceProvenanceBindingRecord
  extends RestorePrivatePromotionSourceProvenanceIdentity {
  readonly bindingVersion: typeof RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_VERSION;
  readonly status: 'BOUND';
  readonly boundAt: string;
  readonly switchIntentSignature: `hmac-sha256:${string}`;
  readonly planFingerprint: `sha256:${string}`;
  readonly candidateSetId: string;
  readonly candidateSetFingerprint: `sha256:${string}`;
  readonly bindingFingerprint: `sha256:${string}`;
  readonly productionMutationAllowed: false;
  readonly promotionExecuted: false;
}

export interface SignedRestorePrivatePromotionSourceProvenanceBindingEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionSourceProvenanceBindingRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Unsupported restore promotion source-provenance binding value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!SHA256_FINGERPRINT.test(value)) throw new Error(`${label} must be a SHA-256 fingerprint`);
}

function assertHmac(value: string, label: string): asserts value is `hmac-sha256:${string}` {
  if (!HMAC_SHA256_SIGNATURE.test(value)) throw new Error(`${label} must be an HMAC-SHA256 signature`);
}

function bindingBody(
  record: Omit<RestorePrivatePromotionSourceProvenanceBindingRecord, 'bindingFingerprint'>,
) {
  return {
    bindingVersion: record.bindingVersion,
    status: record.status,
    boundAt: record.boundAt,
    stagingName: record.stagingName,
    sourceProvenanceSignature: record.sourceProvenanceSignature,
    backupFileName: record.backupFileName,
    backupSha256: record.backupSha256,
    backupCreatedAt: record.backupCreatedAt,
    backupManifestFingerprint: record.backupManifestFingerprint,
    switchIntentSignature: record.switchIntentSignature,
    planFingerprint: record.planFingerprint,
    candidateSetId: record.candidateSetId,
    candidateSetFingerprint: record.candidateSetFingerprint,
    productionMutationAllowed: record.productionMutationAllowed,
    promotionExecuted: record.promotionExecuted,
  };
}

function validateRecord(record: Readonly<RestorePrivatePromotionSourceProvenanceBindingRecord>): void {
  if (record.bindingVersion !== 1 || record.status !== 'BOUND') {
    throw new Error('Restore promotion source-provenance binding version or status is invalid');
  }
  assertTimestamp(record.boundAt, 'Restore promotion source-provenance binding boundAt');
  assertTimestamp(record.backupCreatedAt, 'Restore promotion source-provenance backupCreatedAt');
  if (!STAGING_NAME_PATTERN.test(record.stagingName)) {
    throw new Error('Restore promotion source-provenance staging name is invalid');
  }
  assertHmac(record.sourceProvenanceSignature, 'Restore source provenance signature');
  assertHmac(record.switchIntentSignature, 'Restore promotion switch intent signature');
  assertSha256(record.backupSha256, 'Restore source backup SHA-256');
  assertSha256(record.backupManifestFingerprint, 'Restore source manifest fingerprint');
  assertSha256(record.planFingerprint, 'Restore promotion plan fingerprint');
  assertSha256(record.candidateSetFingerprint, 'Restore promotion candidate-set fingerprint');
  assertSha256(record.bindingFingerprint, 'Restore promotion source-provenance binding fingerprint');
  if (!/^restore-[0-9a-f]{20}$/.test(record.candidateSetId)) {
    throw new Error('Restore promotion source-provenance candidate-set ID is invalid');
  }
  if (record.productionMutationAllowed !== false || record.promotionExecuted !== false) {
    throw new Error('Restore promotion source-provenance binding crossed the production mutation boundary');
  }
  const { bindingFingerprint: _ignored, ...withoutFingerprint } = record;
  if (sha256(canonicalJson(bindingBody(withoutFingerprint))) !== record.bindingFingerprint) {
    throw new Error('Restore promotion source-provenance binding fingerprint does not match its record');
  }
}

function assertSourceBinding(
  record: Readonly<RestorePrivatePromotionSourceProvenanceBindingRecord>,
  provenance: Readonly<SignedRestoreSourceProvenanceEnvelope>,
  switchIntent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>,
): void {
  if (
    record.stagingName !== provenance.record.stagingName
    || record.sourceProvenanceSignature !== provenance.signature
    || record.backupFileName !== provenance.record.backupFileName
    || record.backupSha256 !== provenance.record.backupSha256
    || record.backupCreatedAt !== provenance.record.backupCreatedAt
    || record.backupManifestFingerprint !== provenance.record.backupManifestFingerprint
  ) {
    throw new Error('Restore promotion source-provenance binding does not match verified backup provenance');
  }
  if (
    record.switchIntentSignature !== switchIntent.signature
    || record.planFingerprint !== switchIntent.record.planFingerprint
    || record.candidateSetId !== switchIntent.record.candidateSetId
    || record.candidateSetFingerprint !== switchIntent.record.candidateSetFingerprint
    || record.boundAt !== switchIntent.record.authorizedAt
  ) {
    throw new Error('Restore promotion source-provenance binding does not match authenticated switch intent');
  }
  if (record.backupCreatedAt > record.boundAt) {
    throw new Error('Restore source backup cannot be newer than its promotion authorization');
  }
}

async function readPromotionKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion source-provenance key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore promotion source-provenance key must be a regular non-symlink file');
  const key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('Restore promotion source-provenance key must decode to exactly 32 bytes');
  return key;
}

function signingPayload(record: Readonly<RestorePrivatePromotionSourceProvenanceBindingRecord>): string {
  return `${SIGNING_DOMAIN}${canonicalJson({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_ENVELOPE_VERSION,
    record,
  })}`;
}

function sign(key: Buffer, record: Readonly<RestorePrivatePromotionSourceProvenanceBindingRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(signingPayload(record)).digest('hex')}`;
}

export function createRestorePrivatePromotionSourceProvenanceBindingRecord(
  provenance: Readonly<SignedRestoreSourceProvenanceEnvelope>,
  switchIntent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>,
): Readonly<RestorePrivatePromotionSourceProvenanceBindingRecord> {
  const withoutFingerprint = Object.freeze({
    bindingVersion: 1 as const,
    status: 'BOUND' as const,
    boundAt: switchIntent.record.authorizedAt,
    stagingName: provenance.record.stagingName,
    sourceProvenanceSignature: provenance.signature,
    backupFileName: provenance.record.backupFileName,
    backupSha256: provenance.record.backupSha256,
    backupCreatedAt: provenance.record.backupCreatedAt,
    backupManifestFingerprint: provenance.record.backupManifestFingerprint,
    switchIntentSignature: switchIntent.signature,
    planFingerprint: switchIntent.record.planFingerprint,
    candidateSetId: switchIntent.record.candidateSetId,
    candidateSetFingerprint: switchIntent.record.candidateSetFingerprint,
    productionMutationAllowed: false as const,
    promotionExecuted: false as const,
  });
  const record = Object.freeze({
    ...withoutFingerprint,
    bindingFingerprint: sha256(canonicalJson(bindingBody(withoutFingerprint))),
  });
  validateRecord(record);
  assertSourceBinding(record, provenance, switchIntent);
  return record;
}

export async function readVerifiedRestorePrivatePromotionSourceProvenanceBinding(
  filePath: string,
  promotionKeyFile: string,
  switchIntent: Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>,
): Promise<Readonly<SignedRestorePrivatePromotionSourceProvenanceBindingEnvelope>> {
  if (!isAbsolute(filePath) || basename(filePath) !== RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_FILE_NAME) {
    throw new Error('Restore promotion source-provenance binding path is invalid');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore promotion source-provenance binding must be a regular non-symlink file');
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionSourceProvenanceBindingEnvelope>;
  if (parsed.envelopeVersion !== 1 || !parsed.record || typeof parsed.signature !== 'string') {
    throw new Error('Restore promotion source-provenance binding envelope is invalid');
  }
  validateRecord(parsed.record);
  if (
    parsed.record.switchIntentSignature !== switchIntent.signature
    || parsed.record.planFingerprint !== switchIntent.record.planFingerprint
    || parsed.record.candidateSetId !== switchIntent.record.candidateSetId
    || parsed.record.candidateSetFingerprint !== switchIntent.record.candidateSetFingerprint
  ) {
    throw new Error('Restore promotion source-provenance binding does not match authenticated switch intent');
  }
  assertHmac(parsed.signature, 'Restore promotion source-provenance binding signature');
  const key = await readPromotionKey(promotionKeyFile);
  const expected = sign(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore promotion source-provenance binding signature verification failed');
  }
  return Object.freeze({ envelopeVersion: 1, record: parsed.record, signature: parsed.signature });
}

export async function ensureSignedRestorePrivatePromotionSourceProvenanceBinding(input: Readonly<{
  targetDir: string;
  promotionKeyFile: string;
  backupKeyFile: string;
  sourceProvenanceFile: string;
  switchIntentFile: string;
}>): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSourceProvenanceBindingEnvelope }>> {
  if (!isAbsolute(input.targetDir)) throw new Error('Restore promotion source-provenance target directory must be absolute');
  await mkdir(input.targetDir, { recursive: true, mode: 0o700 });
  const targetStat = await lstat(input.targetDir);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('Restore promotion source-provenance target directory is unsafe');
  await chmod(input.targetDir, 0o700);

  const provenance = await readVerifiedRestoreSourceProvenance(input.sourceProvenanceFile, input.backupKeyFile);
  const switchIntent = await readAuthenticatedRestorePrivatePromotionSwitchIntent(input.switchIntentFile, input.promotionKeyFile);
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivatePromotionSourceProvenanceBinding(finalPath, input.promotionKeyFile, switchIntent);
    assertSourceBinding(existing.record, provenance, switchIntent);
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }

  const record = createRestorePrivatePromotionSourceProvenanceBindingRecord(provenance, switchIntent);
  const key = await readPromotionKey(input.promotionKeyFile);
  const envelope = Object.freeze({ envelopeVersion: 1 as const, record, signature: sign(key, record) });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const temp = join(input.targetDir, `.${RESTORE_PRIVATE_PROMOTION_SOURCE_PROVENANCE_BINDING_FILE_NAME}.${randomUUID()}.tmp`);
  await writeFile(temp, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(temp, finalPath);
      await chmod(finalPath, 0o600);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readVerifiedRestorePrivatePromotionSourceProvenanceBinding(finalPath, input.promotionKeyFile, switchIntent).catch(() => null);
      if (existing) {
        assertSourceBinding(existing.record, provenance, switchIntent);
        return Object.freeze({ path: finalPath, created: false, envelope: existing });
      }
      throw error;
    }
  } finally {
    await rm(temp, { force: true });
  }
}
