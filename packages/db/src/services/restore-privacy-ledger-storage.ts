import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RestorePrivacyReconciliationLedger } from './restore-privacy-ledger';

export const SIGNED_RESTORE_PRIVACY_LEDGER_VERSION = 1 as const;
const SIGNATURE_PREFIX = 'hmac-sha256:';
const LEDGER_FILE_NAME = /^restore-privacy-ledger-[0-9TZ]+-[0-9TZ]+-[0-9a-f]{64}\.json$/;

export interface SignedRestorePrivacyLedgerEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVACY_LEDGER_VERSION;
  readonly ledger: Readonly<RestorePrivacyReconciliationLedger>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface PersistSignedRestorePrivacyLedgerInput {
  readonly ledger: Readonly<RestorePrivacyReconciliationLedger>;
  readonly targetDir: string;
  readonly keyFile: string;
}

function timestampSegment(value: string): string {
  return value.replace(/[-:.]/g, '');
}

async function readLedgerSigningKey(keyFile: string): Promise<Buffer> {
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  if (!encoded) throw new Error('Restore privacy ledger signing key file is empty');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Restore privacy ledger signing key must decode to exactly 32 bytes');
  }
  return key;
}

function canonicalSignedPayload(ledger: Readonly<RestorePrivacyReconciliationLedger>): string {
  return JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVACY_LEDGER_VERSION,
    ledger,
  });
}

function signLedger(
  key: Buffer,
  ledger: Readonly<RestorePrivacyReconciliationLedger>,
): `hmac-sha256:${string}` {
  const hex = createHmac('sha256', key).update(canonicalSignedPayload(ledger)).digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

function assertSignatureShape(signature: string): asserts signature is `hmac-sha256:${string}` {
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(signature)) {
    throw new Error('Restore privacy ledger signature is invalid');
  }
}

export function restorePrivacyLedgerFileName(
  ledger: Readonly<RestorePrivacyReconciliationLedger>,
): string {
  const digest = ledger.entriesFingerprint.slice('sha256:'.length);
  return `restore-privacy-ledger-${timestampSegment(ledger.sinceExclusive)}-${timestampSegment(ledger.generatedAt)}-${digest}.json`;
}

/**
 * Persists one signed restore-privacy ledger outside backup/staging history.
 *
 * The final path is installed with an atomic hard-link from a private temp file on the same
 * filesystem. Existing snapshots are never overwritten; identical retries for the same observation
 * window are accepted only when the already persisted envelope is byte-identical.
 */
export async function persistSignedRestorePrivacyLedger(
  input: PersistSignedRestorePrivacyLedgerInput,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivacyLedgerEnvelope }>> {
  await mkdir(input.targetDir, { recursive: true, mode: 0o700 });
  await chmod(input.targetDir, 0o700);
  const key = await readLedgerSigningKey(input.keyFile);
  const signature = signLedger(key, input.ledger);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVACY_LEDGER_VERSION,
    ledger: input.ledger,
    signature,
  }) satisfies SignedRestorePrivacyLedgerEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(input.targetDir, restorePrivacyLedgerFileName(input.ledger));
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
      throw new Error('Restore privacy ledger snapshot already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** Reads and authenticates one signed ledger snapshot before exposing its payload. */
export async function readVerifiedSignedRestorePrivacyLedger(
  filePath: string,
  keyFile: string,
): Promise<Readonly<SignedRestorePrivacyLedgerEnvelope>> {
  if (!LEDGER_FILE_NAME.test(basename(filePath))) {
    throw new Error('Restore privacy ledger file name is invalid');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivacyLedgerEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVACY_LEDGER_VERSION || !parsed.ledger) {
    throw new Error('Restore privacy ledger envelope version is invalid');
  }
  if (typeof parsed.signature !== 'string') throw new Error('Restore privacy ledger signature is missing');
  assertSignatureShape(parsed.signature);
  const key = await readLedgerSigningKey(keyFile);
  const expected = signLedger(key, parsed.ledger);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore privacy ledger signature verification failed');
  }
  return Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVACY_LEDGER_VERSION,
    ledger: parsed.ledger,
    signature: parsed.signature,
  });
}
