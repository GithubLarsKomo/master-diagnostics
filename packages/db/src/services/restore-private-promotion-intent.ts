import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import {
  RESTORE_PRIVATE_PROMOTION_READINESS_VERSION,
  type RestorePrivatePromotionReadinessReport,
} from './restore-private-promotion-readiness';

export const RESTORE_PRIVATE_PROMOTION_INTENT_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_INTENT_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_PROMOTION_INTENT_FILE_NAME = 'promotion-intent.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-intent:v1\n';
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;

export interface RestorePrivatePromotionIntentRecord {
  readonly intentVersion: typeof RESTORE_PRIVATE_PROMOTION_INTENT_VERSION;
  readonly phase: 'AUTHORIZED';
  readonly authorizedAt: string;
  readonly backupCutoff: string;
  readonly readinessVersion: typeof RESTORE_PRIVATE_PROMOTION_READINESS_VERSION;
  readonly readinessEvidenceFingerprint: `sha256:${string}`;
  readonly healthcheckFingerprint: `sha256:${string}`;
  readonly obligationsFingerprint: `sha256:${string}`;
  readonly artifactEntriesFingerprint: `sha256:${string}` | null;
  readonly recoveryEvidenceStatus: 'NOT_REQUIRED' | 'VERIFIED';
  readonly recoveryPlanFingerprint: `sha256:${string}` | null;
  readonly recoveryIntentSignature: `hmac-sha256:${string}` | null;
  readonly recoveryReceiptSignature: `hmac-sha256:${string}` | null;
  readonly recoveryCompletedAt: string | null;
  readonly authorizationScope: 'PRIVATE_RESTORE_PROMOTION';
  readonly sourceAuthorizationPersisted: false;
  readonly promotionExecuted: false;
}

export interface SignedRestorePrivatePromotionIntentEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_INTENT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionIntentRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface EnsureRestorePrivatePromotionIntentInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly readiness: Readonly<RestorePrivatePromotionReadinessReport>;
  readonly authorizedAt: string;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSha256(value: string | null, label: string): void {
  if (value !== null && !SHA256_FINGERPRINT.test(value)) {
    throw new Error(`${label} must be a sha256 fingerprint`);
  }
}

function assertHmac(value: string | null, label: string): void {
  if (value !== null && !HMAC_SHA256_SIGNATURE.test(value)) {
    throw new Error(`${label} must be an HMAC-SHA256 signature`);
  }
}

/**
 * Validates the semantic boundary between an ephemeral read-only readiness decision and a durable
 * promotion authorization. This does not recompute readiness; callers that cross an operational
 * boundary must first call assessRestorePrivatePromotionReadiness from current raw evidence.
 */
export function verifyRestorePrivatePromotionReadinessForIntent(
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
): void {
  if (readiness.readinessVersion !== RESTORE_PRIVATE_PROMOTION_READINESS_VERSION) {
    throw new Error('Restore private promotion readiness version is unsupported');
  }
  assertCanonicalTimestamp(readiness.backupCutoff, 'Restore private promotion readiness backupCutoff');
  if (
    readiness.status !== 'PROMOTION_READY'
    || readiness.promotionAllowed !== true
    || readiness.authorizationScope !== 'PRIVATE_RESTORE_PROMOTION'
    || readiness.authorizationPersisted !== false
    || readiness.blockers.length !== 0
  ) {
    throw new Error('Restore private promotion intent requires an unblocked non-durable PROMOTION_READY assessment');
  }
  if (
    readiness.healthcheck.status !== 'HEALTHY'
    || readiness.healthcheck.healthcheckPassed !== true
    || readiness.healthcheck.readyForPromotionReview !== true
    || readiness.healthcheck.promotionAllowed !== false
    || readiness.healthcheck.backupCutoff !== readiness.backupCutoff
    || readiness.healthcheck.reconciliationStatus !== readiness.reconciliationStatus
    || readiness.healthcheck.databaseStatus !== 'DATABASE_SATISFIED'
    || readiness.healthcheck.artifactManifestVerified !== true
    || readiness.healthcheck.artifactReplayVerified !== true
    || readiness.healthcheck.blockers.length !== 0
  ) {
    throw new Error('Restore private promotion readiness healthcheck is not authorizable');
  }
  if (readiness.reconciliationStatus === 'BLOCKED') {
    throw new Error('Restore private promotion readiness cannot authorize blocked reconciliation');
  }
  assertSha256(readiness.evidenceFingerprint, 'Restore private promotion readiness evidenceFingerprint');
  assertSha256(readiness.healthcheckFingerprint, 'Restore private promotion readiness healthcheckFingerprint');
  assertSha256(readiness.obligationsFingerprint, 'Restore private promotion readiness obligationsFingerprint');
  assertSha256(readiness.artifactEntriesFingerprint, 'Restore private promotion readiness artifactEntriesFingerprint');
  assertSha256(readiness.recoveryPlanFingerprint, 'Restore private promotion readiness recoveryPlanFingerprint');
  assertHmac(readiness.recoveryIntentSignature, 'Restore private promotion readiness recoveryIntentSignature');
  assertHmac(readiness.recoveryReceiptSignature, 'Restore private promotion readiness recoveryReceiptSignature');

  if (readiness.recoveryEvidenceStatus === 'NOT_REQUIRED') {
    if (
      readiness.recoveryPlanFingerprint !== null
      || readiness.recoveryIntentSignature !== null
      || readiness.recoveryReceiptSignature !== null
      || readiness.recoveryCompletedAt !== null
    ) {
      throw new Error('Restore private promotion readiness has unexpected recovery evidence');
    }
    return;
  }
  if (readiness.recoveryEvidenceStatus !== 'VERIFIED') {
    throw new Error('Restore private promotion readiness has unresolved recovery evidence');
  }
  if (
    !readiness.recoveryPlanFingerprint
    || !readiness.recoveryIntentSignature
    || !readiness.recoveryReceiptSignature
    || !readiness.recoveryCompletedAt
  ) {
    throw new Error('Restore private promotion readiness verified recovery evidence is incomplete');
  }
  assertCanonicalTimestamp(
    readiness.recoveryCompletedAt,
    'Restore private promotion readiness recoveryCompletedAt',
  );
  if (readiness.recoveryCompletedAt < readiness.backupCutoff) {
    throw new Error('Restore private promotion recovery completion must not precede the backup cutoff');
  }
}

function validateRecord(record: Readonly<RestorePrivatePromotionIntentRecord>): void {
  if (record.intentVersion !== RESTORE_PRIVATE_PROMOTION_INTENT_VERSION || record.phase !== 'AUTHORIZED') {
    throw new Error('Restore private promotion intent version or phase is invalid');
  }
  assertCanonicalTimestamp(record.authorizedAt, 'Restore private promotion intent authorizedAt');
  assertCanonicalTimestamp(record.backupCutoff, 'Restore private promotion intent backupCutoff');
  if (record.authorizedAt < record.backupCutoff) {
    throw new Error('Restore private promotion intent authorization must not precede the backup cutoff');
  }
  if (record.readinessVersion !== RESTORE_PRIVATE_PROMOTION_READINESS_VERSION) {
    throw new Error('Restore private promotion intent readiness version is invalid');
  }
  assertSha256(record.readinessEvidenceFingerprint, 'Restore private promotion intent readinessEvidenceFingerprint');
  assertSha256(record.healthcheckFingerprint, 'Restore private promotion intent healthcheckFingerprint');
  assertSha256(record.obligationsFingerprint, 'Restore private promotion intent obligationsFingerprint');
  assertSha256(record.artifactEntriesFingerprint, 'Restore private promotion intent artifactEntriesFingerprint');
  assertSha256(record.recoveryPlanFingerprint, 'Restore private promotion intent recoveryPlanFingerprint');
  assertHmac(record.recoveryIntentSignature, 'Restore private promotion intent recoveryIntentSignature');
  assertHmac(record.recoveryReceiptSignature, 'Restore private promotion intent recoveryReceiptSignature');
  if (
    record.authorizationScope !== 'PRIVATE_RESTORE_PROMOTION'
    || record.sourceAuthorizationPersisted !== false
    || record.promotionExecuted !== false
  ) {
    throw new Error('Restore private promotion intent authorization boundary is invalid');
  }
  if (record.recoveryEvidenceStatus === 'NOT_REQUIRED') {
    if (
      record.recoveryPlanFingerprint !== null
      || record.recoveryIntentSignature !== null
      || record.recoveryReceiptSignature !== null
      || record.recoveryCompletedAt !== null
    ) {
      throw new Error('Restore private promotion intent has unexpected recovery evidence');
    }
    return;
  }
  if (record.recoveryEvidenceStatus !== 'VERIFIED') {
    throw new Error('Restore private promotion intent recovery evidence status is invalid');
  }
  if (
    !record.recoveryPlanFingerprint
    || !record.recoveryIntentSignature
    || !record.recoveryReceiptSignature
    || !record.recoveryCompletedAt
  ) {
    throw new Error('Restore private promotion intent recovery evidence is incomplete');
  }
  assertCanonicalTimestamp(record.recoveryCompletedAt, 'Restore private promotion intent recoveryCompletedAt');
  if (record.authorizedAt < record.recoveryCompletedAt) {
    throw new Error('Restore private promotion intent authorization must not precede recovery completion');
  }
}

function assertReadinessBinding(
  record: Readonly<RestorePrivatePromotionIntentRecord>,
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
): void {
  verifyRestorePrivatePromotionReadinessForIntent(readiness);
  if (
    record.backupCutoff !== readiness.backupCutoff
    || record.readinessVersion !== readiness.readinessVersion
    || record.readinessEvidenceFingerprint !== readiness.evidenceFingerprint
    || record.healthcheckFingerprint !== readiness.healthcheckFingerprint
    || record.obligationsFingerprint !== readiness.obligationsFingerprint
    || record.artifactEntriesFingerprint !== readiness.artifactEntriesFingerprint
    || record.recoveryEvidenceStatus !== readiness.recoveryEvidenceStatus
    || record.recoveryPlanFingerprint !== readiness.recoveryPlanFingerprint
    || record.recoveryIntentSignature !== readiness.recoveryIntentSignature
    || record.recoveryReceiptSignature !== readiness.recoveryReceiptSignature
    || record.recoveryCompletedAt !== readiness.recoveryCompletedAt
  ) {
    throw new Error('Restore private promotion intent does not match its promotion readiness evidence');
  }
}

async function assertRegularNonSymlinkFile(filePath: string, label: string): Promise<void> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore private promotion intent signing key path must be absolute');
  await assertRegularNonSymlinkFile(keyFile, 'Restore private promotion intent signing key');
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  if (!encoded) throw new Error('Restore private promotion intent signing key file is empty');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Restore private promotion intent signing key must decode to exactly 32 bytes');
  }
  return key;
}

async function ensureTargetDirectory(targetDir: string): Promise<void> {
  if (!isAbsolute(targetDir)) throw new Error('Restore private promotion intent target directory must be absolute');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(targetDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restore private promotion intent target must be a non-symlink directory');
  }
  await chmod(targetDir, 0o700);
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionIntentRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_INTENT_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivatePromotionIntentRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

export function createRestorePrivatePromotionIntentRecord(
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
  authorizedAt: string,
): Readonly<RestorePrivatePromotionIntentRecord> {
  verifyRestorePrivatePromotionReadinessForIntent(readiness);
  const record = Object.freeze({
    intentVersion: RESTORE_PRIVATE_PROMOTION_INTENT_VERSION,
    phase: 'AUTHORIZED' as const,
    authorizedAt,
    backupCutoff: readiness.backupCutoff,
    readinessVersion: readiness.readinessVersion,
    readinessEvidenceFingerprint: readiness.evidenceFingerprint,
    healthcheckFingerprint: readiness.healthcheckFingerprint,
    obligationsFingerprint: readiness.obligationsFingerprint,
    artifactEntriesFingerprint: readiness.artifactEntriesFingerprint,
    recoveryEvidenceStatus: readiness.recoveryEvidenceStatus as 'NOT_REQUIRED' | 'VERIFIED',
    recoveryPlanFingerprint: readiness.recoveryPlanFingerprint,
    recoveryIntentSignature: readiness.recoveryIntentSignature,
    recoveryReceiptSignature: readiness.recoveryReceiptSignature,
    recoveryCompletedAt: readiness.recoveryCompletedAt,
    authorizationScope: 'PRIVATE_RESTORE_PROMOTION' as const,
    sourceAuthorizationPersisted: false as const,
    promotionExecuted: false as const,
  });
  validateRecord(record);
  assertReadinessBinding(record, readiness);
  return record;
}

export async function readVerifiedRestorePrivatePromotionIntent(
  filePath: string,
  keyFile: string,
  readiness: Readonly<RestorePrivatePromotionReadinessReport>,
): Promise<Readonly<SignedRestorePrivatePromotionIntentEnvelope>> {
  if (basename(filePath) !== RESTORE_PRIVATE_PROMOTION_INTENT_FILE_NAME) {
    throw new Error('Restore private promotion intent file name is invalid');
  }
  if (!isAbsolute(filePath)) throw new Error('Restore private promotion intent file path must be absolute');
  await assertRegularNonSymlinkFile(filePath, 'Restore private promotion intent');
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionIntentEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_PROMOTION_INTENT_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore private promotion intent envelope version is invalid');
  }
  validateRecord(parsed.record);
  assertReadinessBinding(parsed.record, readiness);
  if (typeof parsed.signature !== 'string' || !HMAC_SHA256_SIGNATURE.test(parsed.signature)) {
    throw new Error('Restore private promotion intent signature is invalid');
  }
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore private promotion intent signature verification failed');
  }
  return Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_INTENT_ENVELOPE_VERSION,
    record: parsed.record,
    signature: parsed.signature,
  });
}

export async function persistSignedRestorePrivatePromotionIntent(
  targetDir: string,
  keyFile: string,
  record: Readonly<RestorePrivatePromotionIntentRecord>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionIntentEnvelope }>> {
  validateRecord(record);
  await ensureTargetDirectory(targetDir);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_INTENT_ENVELOPE_VERSION,
    record,
    signature: signRecord(key, record),
  }) satisfies SignedRestorePrivatePromotionIntentEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(targetDir, RESTORE_PRIVATE_PROMOTION_INTENT_FILE_NAME);
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_PROMOTION_INTENT_FILE_NAME}.${crypto.randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readFile(finalPath, 'utf8').catch(() => null);
      if (existing === serialized) return Object.freeze({ path: finalPath, created: false, envelope });
      throw new Error('Restore private promotion intent already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function ensureSignedRestorePrivatePromotionIntent(
  input: Readonly<EnsureRestorePrivatePromotionIntentInput>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionIntentEnvelope }>> {
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_PROMOTION_INTENT_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivatePromotionIntent(
      finalPath,
      input.keyFile,
      input.readiness,
    );
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }

  const record = createRestorePrivatePromotionIntentRecord(input.readiness, input.authorizedAt);
  try {
    return await persistSignedRestorePrivatePromotionIntent(input.targetDir, input.keyFile, record);
  } catch (error) {
    const existing = await readVerifiedRestorePrivatePromotionIntent(
      finalPath,
      input.keyFile,
      input.readiness,
    ).catch(() => null);
    if (existing) return Object.freeze({ path: finalPath, created: false, envelope: existing });
    throw error;
  }
}
