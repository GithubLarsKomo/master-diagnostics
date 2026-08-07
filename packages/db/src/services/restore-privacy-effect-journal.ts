import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVACY_EFFECT_ENVELOPE_VERSION = 1 as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_NAME = /^privacy-effect-([0-9a-f-]{36})-(pending|terminal)\.json$/;
const SIGNING_DOMAIN = 'masters:restore-privacy-effect-journal:v1\n';

export type RestorePrivacyEffectPhase = 'PENDING' | 'COMMITTED' | 'ABORTED';

export interface RestorePrivacyEffectIdentity {
  readonly tenantId: string;
  readonly athleteId: string;
  readonly executionId: string;
  readonly approvalId: string;
  readonly deletionRequestId: string;
  readonly executionVersion: number;
  readonly policyVersion: string;
  readonly scopeFingerprint: string;
  readonly capabilityFingerprint: string;
}

interface RestorePrivacyEffectRecordBase {
  readonly journalVersion: typeof RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION;
  readonly phase: RestorePrivacyEffectPhase;
  readonly recordedAt: string;
  readonly effect: Readonly<RestorePrivacyEffectIdentity>;
}

export interface PendingRestorePrivacyEffectRecord extends RestorePrivacyEffectRecordBase {
  readonly phase: 'PENDING';
}

export interface CommittedRestorePrivacyEffectRecord extends RestorePrivacyEffectRecordBase {
  readonly phase: 'COMMITTED';
  readonly dbCommittedAt: string;
}

export interface AbortedRestorePrivacyEffectRecord extends RestorePrivacyEffectRecordBase {
  readonly phase: 'ABORTED';
}

export type RestorePrivacyEffectRecord =
  | PendingRestorePrivacyEffectRecord
  | CommittedRestorePrivacyEffectRecord
  | AbortedRestorePrivacyEffectRecord;

export interface SignedRestorePrivacyEffectEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVACY_EFFECT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivacyEffectRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface PersistRestorePrivacyEffectRecordInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly record: Readonly<RestorePrivacyEffectRecord>;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function validateRecord(record: Readonly<RestorePrivacyEffectRecord>): void {
  if (record.journalVersion !== RESTORE_PRIVACY_EFFECT_JOURNAL_VERSION) {
    throw new Error('Restore privacy effect journal version is invalid');
  }
  assertCanonicalTimestamp(record.recordedAt, 'Restore privacy effect recordedAt');
  if (!EXECUTION_ID.test(record.effect.executionId)) {
    throw new Error('Restore privacy effect executionId must be a canonical UUID');
  }
  for (const [label, value] of [
    ['tenantId', record.effect.tenantId],
    ['athleteId', record.effect.athleteId],
    ['approvalId', record.effect.approvalId],
    ['deletionRequestId', record.effect.deletionRequestId],
    ['policyVersion', record.effect.policyVersion],
  ] as const) assertNonEmpty(value, `Restore privacy effect ${label}`);
  if (!Number.isInteger(record.effect.executionVersion) || record.effect.executionVersion < 1) {
    throw new Error('Restore privacy effect executionVersion must be a positive integer');
  }
  if (!FINGERPRINT.test(record.effect.scopeFingerprint)
    || !FINGERPRINT.test(record.effect.capabilityFingerprint)) {
    throw new Error('Restore privacy effect fingerprints are invalid');
  }
  if (record.phase === 'COMMITTED') {
    assertCanonicalTimestamp(record.dbCommittedAt, 'Restore privacy effect dbCommittedAt');
    if (record.dbCommittedAt > record.recordedAt) {
      throw new Error('Restore privacy effect commit time must not follow its journal time');
    }
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  if (!encoded) throw new Error('Restore privacy effect signing key file is empty');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Restore privacy effect signing key must decode to exactly 32 bytes');
  }
  return key;
}

function canonicalPayload(record: Readonly<RestorePrivacyEffectRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVACY_EFFECT_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivacyEffectRecord>): `hmac-sha256:${string}` {
  const digest = createHmac('sha256', key).update(canonicalPayload(record)).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

function markerSegment(phase: RestorePrivacyEffectPhase): 'pending' | 'terminal' {
  return phase === 'PENDING' ? 'pending' : 'terminal';
}

export function restorePrivacyEffectFileName(record: Readonly<RestorePrivacyEffectRecord>): string {
  validateRecord(record);
  return `privacy-effect-${record.effect.executionId}-${markerSegment(record.phase)}.json`;
}

function assertSignatureShape(signature: string): asserts signature is `hmac-sha256:${string}` {
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(signature)) {
    throw new Error('Restore privacy effect signature is invalid');
  }
}

function sameEffectIdentity(
  left: Readonly<RestorePrivacyEffectIdentity>,
  right: Readonly<RestorePrivacyEffectIdentity>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifiedEnvelopeFromPath(
  filePath: string,
  keyFile: string,
): Promise<Readonly<SignedRestorePrivacyEffectEnvelope>> {
  if (!FILE_NAME.test(basename(filePath))) throw new Error('Restore privacy effect file name is invalid');
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivacyEffectEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVACY_EFFECT_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore privacy effect envelope version is invalid');
  }
  validateRecord(parsed.record);
  if (basename(filePath) !== restorePrivacyEffectFileName(parsed.record)) {
    throw new Error('Restore privacy effect file name does not match its signed record');
  }
  if (typeof parsed.signature !== 'string') throw new Error('Restore privacy effect signature is missing');
  assertSignatureShape(parsed.signature);
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore privacy effect signature verification failed');
  }
  return Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVACY_EFFECT_ENVELOPE_VERSION,
    record: parsed.record,
    signature: parsed.signature,
  });
}

/**
 * Persists one immutable signed privacy-effect marker outside backup history.
 *
 * PENDING owns a dedicated slot. COMMITTED and ABORTED compete for exactly one terminal slot,
 * which prevents contradictory outcomes from being durably accepted for the same execution.
 * A terminal marker is accepted only after the signed PENDING marker exists and carries the
 * exact same technical reconciliation identity.
 */
export async function persistSignedRestorePrivacyEffectRecord(
  input: PersistRestorePrivacyEffectRecordInput,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivacyEffectEnvelope }>> {
  validateRecord(input.record);
  await mkdir(input.targetDir, { recursive: true, mode: 0o700 });
  await chmod(input.targetDir, 0o700);

  if (input.record.phase !== 'PENDING') {
    const pendingPath = join(input.targetDir, `privacy-effect-${input.record.effect.executionId}-pending.json`);
    const pendingEnvelope = await verifiedEnvelopeFromPath(pendingPath, input.keyFile)
      .catch((error: unknown) => {
        throw new Error('Verified PENDING restore privacy effect marker required before terminal marker', {
          cause: error,
        });
      });
    if (pendingEnvelope.record.phase !== 'PENDING'
      || !sameEffectIdentity(pendingEnvelope.record.effect, input.record.effect)) {
      throw new Error('Restore privacy effect terminal marker does not match its PENDING intent');
    }
    if (input.record.recordedAt < pendingEnvelope.record.recordedAt) {
      throw new Error('Restore privacy effect terminal marker must not precede PENDING intent');
    }
  }

  const key = await readSigningKey(input.keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVACY_EFFECT_ENVELOPE_VERSION,
    record: input.record,
    signature: signRecord(key, input.record),
  }) satisfies SignedRestorePrivacyEffectEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(input.targetDir, restorePrivacyEffectFileName(input.record));
  const tempPath = join(input.targetDir, `.${basename(finalPath)}.${crypto.randomUUID()}.tmp`);

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
      throw new Error('Restore privacy effect marker already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** Reads and authenticates one immutable journal marker before exposing it. */
export async function readVerifiedRestorePrivacyEffectRecord(
  filePath: string,
  keyFile: string,
): Promise<Readonly<SignedRestorePrivacyEffectEnvelope>> {
  return verifiedEnvelopeFromPath(filePath, keyFile);
}
