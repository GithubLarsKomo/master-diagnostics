import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  verifyRestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlan,
} from './restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVATE_RECOVERY_INTENT_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_RECOVERY_INTENT_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME = 'recovery-execution-pending.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-recovery-intent:v1\n';
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export interface RestorePrivateRecoveryIntentRecord {
  readonly intentVersion: typeof RESTORE_PRIVATE_RECOVERY_INTENT_VERSION;
  readonly phase: 'PENDING';
  readonly startedAt: string;
  readonly backupCutoff: string;
  readonly planVersion: 1;
  readonly planFingerprint: `sha256:${string}`;
  readonly actionsFingerprint: `sha256:${string}`;
  readonly actionCount: number;
  readonly promotionAllowed: false;
}

export interface SignedRestorePrivateRecoveryIntentEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_RECOVERY_INTENT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivateRecoveryIntentRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface EnsureRestorePrivateRecoveryIntentInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly plan: Readonly<RestorePrivateRecoveryPlan>;
  readonly reconciliation: Readonly<RestorePrivacyReconciliationReport>;
  readonly startedAt: string;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSignatureShape(signature: string): asserts signature is `hmac-sha256:${string}` {
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(signature)) {
    throw new Error('Restore private recovery intent signature is invalid');
  }
}

function validateRecord(record: Readonly<RestorePrivateRecoveryIntentRecord>): void {
  if (record.intentVersion !== RESTORE_PRIVATE_RECOVERY_INTENT_VERSION || record.phase !== 'PENDING') {
    throw new Error('Restore private recovery intent version or phase is invalid');
  }
  assertCanonicalTimestamp(record.startedAt, 'Restore private recovery intent startedAt');
  assertCanonicalTimestamp(record.backupCutoff, 'Restore private recovery intent backupCutoff');
  if (record.startedAt < record.backupCutoff) {
    throw new Error('Restore private recovery intent must not precede its backup cutoff');
  }
  if (record.planVersion !== 1) throw new Error('Restore private recovery intent plan version is invalid');
  if (!SHA256_FINGERPRINT.test(record.planFingerprint)
    || !SHA256_FINGERPRINT.test(record.actionsFingerprint)) {
    throw new Error('Restore private recovery intent fingerprints are invalid');
  }
  if (!Number.isInteger(record.actionCount) || record.actionCount < 1) {
    throw new Error('Restore private recovery intent action count must be positive');
  }
  if (record.promotionAllowed !== false) {
    throw new Error('Restore private recovery intent must never allow promotion');
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  if (!encoded) throw new Error('Restore private recovery intent signing key file is empty');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Restore private recovery intent signing key must decode to exactly 32 bytes');
  }
  return key;
}

function canonicalPayload(record: Readonly<RestorePrivateRecoveryIntentRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_RECOVERY_INTENT_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivateRecoveryIntentRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

function assertPlanBinding(
  record: Readonly<RestorePrivateRecoveryIntentRecord>,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): void {
  verifyRestorePrivateRecoveryPlan(plan, reconciliation);
  if (
    record.backupCutoff !== plan.backupCutoff
    || record.planVersion !== plan.planVersion
    || record.planFingerprint !== plan.planFingerprint
    || record.actionsFingerprint !== plan.actionsFingerprint
    || record.actionCount !== plan.actionCount
  ) {
    throw new Error('Restore private recovery intent does not match its verified recovery plan');
  }
  if (reconciliation.ledger && record.startedAt < reconciliation.ledger.generatedAt) {
    throw new Error('Restore private recovery intent must not precede the reconciliation ledger evidence');
  }
}

export function createRestorePrivateRecoveryIntentRecord(
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  startedAt: string,
): Readonly<RestorePrivateRecoveryIntentRecord> {
  verifyRestorePrivateRecoveryPlan(plan, reconciliation);
  const record = Object.freeze({
    intentVersion: RESTORE_PRIVATE_RECOVERY_INTENT_VERSION,
    phase: 'PENDING' as const,
    startedAt,
    backupCutoff: plan.backupCutoff,
    planVersion: plan.planVersion,
    planFingerprint: plan.planFingerprint,
    actionsFingerprint: plan.actionsFingerprint,
    actionCount: plan.actionCount,
    promotionAllowed: false as const,
  });
  validateRecord(record);
  assertPlanBinding(record, plan, reconciliation);
  return record;
}

async function verifiedEnvelopeFromPath(
  filePath: string,
  keyFile: string,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<SignedRestorePrivateRecoveryIntentEnvelope>> {
  if (basename(filePath) !== RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME) {
    throw new Error('Restore private recovery intent file name is invalid');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivateRecoveryIntentEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_RECOVERY_INTENT_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore private recovery intent envelope version is invalid');
  }
  validateRecord(parsed.record);
  assertPlanBinding(parsed.record, plan, reconciliation);
  if (typeof parsed.signature !== 'string') throw new Error('Restore private recovery intent signature is missing');
  assertSignatureShape(parsed.signature);
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore private recovery intent signature verification failed');
  }
  return Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_RECOVERY_INTENT_ENVELOPE_VERSION,
    record: parsed.record,
    signature: parsed.signature,
  });
}

/** Reads and authenticates the immutable PENDING recovery intent before exposing it. */
export async function readVerifiedRestorePrivateRecoveryIntent(
  filePath: string,
  keyFile: string,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<SignedRestorePrivateRecoveryIntentEnvelope>> {
  return verifiedEnvelopeFromPath(filePath, keyFile, plan, reconciliation);
}

/**
 * Persists the immutable signed recovery intent before the first recovery mutation.
 *
 * Exact retries are idempotent. A different plan or timestamp cannot replace an already durable
 * intent. The caller should use ensureSignedRestorePrivateRecoveryIntent so retries first reuse the
 * existing verified startedAt rather than generating a new recovery time.
 */
export async function persistSignedRestorePrivateRecoveryIntent(
  targetDir: string,
  keyFile: string,
  record: Readonly<RestorePrivateRecoveryIntentRecord>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivateRecoveryIntentEnvelope }>> {
  validateRecord(record);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await chmod(targetDir, 0o700);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_RECOVERY_INTENT_ENVELOPE_VERSION,
    record,
    signature: signRecord(key, record),
  }) satisfies SignedRestorePrivateRecoveryIntentEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(targetDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME);
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME}.${crypto.randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readFile(finalPath, 'utf8').catch(() => null);
      if (existing === serialized) {
        return Object.freeze({ path: finalPath, created: false, envelope });
      }
      throw new Error('Restore private recovery intent already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Reuses an already verified durable intent on retry; otherwise creates exactly one new PENDING
 * intent. Concurrent creators converge on the first valid intent for the same verified plan.
 */
export async function ensureSignedRestorePrivateRecoveryIntent(
  input: Readonly<EnsureRestorePrivateRecoveryIntentInput>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivateRecoveryIntentEnvelope }>> {
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_RECOVERY_INTENT_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivateRecoveryIntent(
      finalPath,
      input.keyFile,
      input.plan,
      input.reconciliation,
    );
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }

  const record = createRestorePrivateRecoveryIntentRecord(
    input.plan,
    input.reconciliation,
    input.startedAt,
  );
  try {
    return await persistSignedRestorePrivateRecoveryIntent(input.targetDir, input.keyFile, record);
  } catch (error) {
    const existing = await readVerifiedRestorePrivateRecoveryIntent(
      finalPath,
      input.keyFile,
      input.plan,
      input.reconciliation,
    ).catch(() => null);
    if (existing) return Object.freeze({ path: finalPath, created: false, envelope: existing });
    throw error;
  }
}
