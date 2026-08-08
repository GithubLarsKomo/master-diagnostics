import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RestorePrivateRecoveryExecutionResult } from './restore-private-recovery-executor';
import {
  readVerifiedRestorePrivateRecoveryIntent,
  type SignedRestorePrivateRecoveryIntentEnvelope,
} from './restore-private-recovery-intent';
import {
  verifyRestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlan,
  type RestorePrivateRecoveryPlanAction,
} from './restore-private-recovery-plan';
import type { RestorePrivacyReconciliationReport } from './restore-privacy-reconciliation-report';

export const RESTORE_PRIVATE_RECOVERY_RECEIPT_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_RECOVERY_RECEIPT_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME = 'recovery-execution-completed.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-recovery-receipt:v1\n';
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;

export type RestorePrivateRecoveryTerminalEvidence =
  | 'ABORTED_EXECUTION'
  | 'COMPLETED_EXECUTION'
  | 'RESTORE_NORMALIZATION';

export interface RestorePrivateRecoveryReceiptAction {
  readonly executionId: string;
  readonly action: RestorePrivateRecoveryPlanAction['action'];
  readonly terminalEvidence: RestorePrivateRecoveryTerminalEvidence;
}

export interface RestorePrivateRecoveryReceiptRecord {
  readonly receiptVersion: typeof RESTORE_PRIVATE_RECOVERY_RECEIPT_VERSION;
  readonly phase: 'COMPLETED';
  readonly backupCutoff: string;
  readonly planVersion: 1;
  readonly planFingerprint: `sha256:${string}`;
  readonly actionsFingerprint: `sha256:${string}`;
  readonly intentSignature: `hmac-sha256:${string}`;
  readonly recoveryStartedAt: string;
  readonly recoveryCompletedAt: string;
  readonly actionCount: number;
  readonly actions: readonly Readonly<RestorePrivateRecoveryReceiptAction>[];
  readonly promotionAllowed: false;
}

export interface SignedRestorePrivateRecoveryReceiptEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_RECOVERY_RECEIPT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivateRecoveryReceiptRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface EnsureRestorePrivateRecoveryReceiptInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly intentFile: string;
  readonly plan: Readonly<RestorePrivateRecoveryPlan>;
  readonly reconciliation: Readonly<RestorePrivacyReconciliationReport>;
  readonly executionResult: Readonly<RestorePrivateRecoveryExecutionResult>;
  readonly completedAt: string;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function expectedTerminalEvidence(
  action: RestorePrivateRecoveryPlanAction['action'],
): RestorePrivateRecoveryTerminalEvidence {
  if (action === 'ABORT_PREPARING' || action === 'RESTORE_ARTIFACTS_AND_ABORT') {
    return 'ABORTED_EXECUTION';
  }
  if (action === 'PURGE_ARTIFACTS_AND_COMPLETE') return 'COMPLETED_EXECUTION';
  return 'RESTORE_NORMALIZATION';
}

function assertExecutionResultBinding(
  result: Readonly<RestorePrivateRecoveryExecutionResult>,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
): void {
  if (
    result.mode !== 'ISOLATED_RESTORE_RECOVERY_EXECUTION'
    || result.backupCutoff !== plan.backupCutoff
    || result.planFingerprint !== plan.planFingerprint
    || result.recoveryStartedAt !== intent.record.startedAt
    || result.actionCount !== plan.actionCount
    || result.actions.length !== plan.actions.length
    || result.appliedCount + result.alreadyAppliedCount !== result.actionCount
    || result.promotionAllowed !== false
  ) {
    throw new Error('Restore private recovery execution result does not match its verified plan and intent');
  }
  for (const [index, planned] of plan.actions.entries()) {
    const actual = result.actions[index];
    if (
      !actual
      || actual.executionId !== planned.executionId
      || actual.action !== planned.action
      || actual.terminalEvidence !== expectedTerminalEvidence(planned.action)
    ) {
      throw new Error('Restore private recovery execution result action does not match its verified plan');
    }
  }
}

function receiptActions(
  plan: Readonly<RestorePrivateRecoveryPlan>,
): readonly Readonly<RestorePrivateRecoveryReceiptAction>[] {
  return Object.freeze(plan.actions.map((action) => Object.freeze({
    executionId: action.executionId,
    action: action.action,
    terminalEvidence: expectedTerminalEvidence(action.action),
  })));
}

function validateRecord(record: Readonly<RestorePrivateRecoveryReceiptRecord>): void {
  if (record.receiptVersion !== RESTORE_PRIVATE_RECOVERY_RECEIPT_VERSION || record.phase !== 'COMPLETED') {
    throw new Error('Restore private recovery receipt version or phase is invalid');
  }
  assertCanonicalTimestamp(record.backupCutoff, 'Restore private recovery receipt backupCutoff');
  assertCanonicalTimestamp(record.recoveryStartedAt, 'Restore private recovery receipt recoveryStartedAt');
  assertCanonicalTimestamp(record.recoveryCompletedAt, 'Restore private recovery receipt recoveryCompletedAt');
  if (record.recoveryStartedAt < record.backupCutoff) {
    throw new Error('Restore private recovery receipt start must not precede the backup cutoff');
  }
  if (record.recoveryCompletedAt < record.recoveryStartedAt) {
    throw new Error('Restore private recovery receipt completion must not precede recovery start');
  }
  if (record.planVersion !== 1) throw new Error('Restore private recovery receipt plan version is invalid');
  if (!SHA256_FINGERPRINT.test(record.planFingerprint) || !SHA256_FINGERPRINT.test(record.actionsFingerprint)) {
    throw new Error('Restore private recovery receipt fingerprints are invalid');
  }
  if (!HMAC_SHA256_SIGNATURE.test(record.intentSignature)) {
    throw new Error('Restore private recovery receipt intent signature is invalid');
  }
  if (!Number.isInteger(record.actionCount) || record.actionCount < 1 || record.actions.length !== record.actionCount) {
    throw new Error('Restore private recovery receipt action count is invalid');
  }
  const executionIds = new Set<string>();
  for (const action of record.actions) {
    if (!action.executionId.trim() || executionIds.has(action.executionId)) {
      throw new Error('Restore private recovery receipt action execution IDs are invalid');
    }
    executionIds.add(action.executionId);
    if (action.terminalEvidence !== expectedTerminalEvidence(action.action)) {
      throw new Error('Restore private recovery receipt terminal evidence is invalid');
    }
  }
  if (record.promotionAllowed !== false) {
    throw new Error('Restore private recovery receipt must never allow promotion');
  }
}

function assertReceiptBinding(
  record: Readonly<RestorePrivateRecoveryReceiptRecord>,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
  intent: Readonly<SignedRestorePrivateRecoveryIntentEnvelope>,
): void {
  verifyRestorePrivateRecoveryPlan(plan, reconciliation);
  if (
    record.backupCutoff !== plan.backupCutoff
    || record.planVersion !== plan.planVersion
    || record.planFingerprint !== plan.planFingerprint
    || record.actionsFingerprint !== plan.actionsFingerprint
    || record.intentSignature !== intent.signature
    || record.recoveryStartedAt !== intent.record.startedAt
    || record.actionCount !== plan.actionCount
  ) {
    throw new Error('Restore private recovery receipt does not match its verified recovery evidence');
  }
  const expected = receiptActions(plan);
  if (JSON.stringify(record.actions) !== JSON.stringify(expected)) {
    throw new Error('Restore private recovery receipt actions do not match its verified plan');
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  if (!encoded) throw new Error('Restore private recovery receipt signing key file is empty');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('Restore private recovery receipt signing key must decode to exactly 32 bytes');
  }
  return key;
}

function canonicalPayload(record: Readonly<RestorePrivateRecoveryReceiptRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_RECOVERY_RECEIPT_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivateRecoveryReceiptRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

export async function createRestorePrivateRecoveryReceiptRecord(
  input: Readonly<EnsureRestorePrivateRecoveryReceiptInput>,
): Promise<Readonly<RestorePrivateRecoveryReceiptRecord>> {
  verifyRestorePrivateRecoveryPlan(input.plan, input.reconciliation);
  const intent = await readVerifiedRestorePrivateRecoveryIntent(
    input.intentFile,
    input.keyFile,
    input.plan,
    input.reconciliation,
  );
  assertExecutionResultBinding(input.executionResult, input.plan, intent);
  const record = Object.freeze({
    receiptVersion: RESTORE_PRIVATE_RECOVERY_RECEIPT_VERSION,
    phase: 'COMPLETED' as const,
    backupCutoff: input.plan.backupCutoff,
    planVersion: input.plan.planVersion,
    planFingerprint: input.plan.planFingerprint,
    actionsFingerprint: input.plan.actionsFingerprint,
    intentSignature: intent.signature,
    recoveryStartedAt: intent.record.startedAt,
    recoveryCompletedAt: input.completedAt,
    actionCount: input.plan.actionCount,
    actions: receiptActions(input.plan),
    promotionAllowed: false as const,
  });
  validateRecord(record);
  assertReceiptBinding(record, input.plan, input.reconciliation, intent);
  return record;
}

export async function readVerifiedRestorePrivateRecoveryReceipt(
  filePath: string,
  keyFile: string,
  intentFile: string,
  plan: Readonly<RestorePrivateRecoveryPlan>,
  reconciliation: Readonly<RestorePrivacyReconciliationReport>,
): Promise<Readonly<SignedRestorePrivateRecoveryReceiptEnvelope>> {
  if (basename(filePath) !== RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME) {
    throw new Error('Restore private recovery receipt file name is invalid');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivateRecoveryReceiptEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_RECOVERY_RECEIPT_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore private recovery receipt envelope version is invalid');
  }
  validateRecord(parsed.record);
  const intent = await readVerifiedRestorePrivateRecoveryIntent(
    intentFile,
    keyFile,
    plan,
    reconciliation,
  );
  assertReceiptBinding(parsed.record, plan, reconciliation, intent);
  if (typeof parsed.signature !== 'string' || !HMAC_SHA256_SIGNATURE.test(parsed.signature)) {
    throw new Error('Restore private recovery receipt signature is invalid');
  }
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore private recovery receipt signature verification failed');
  }
  return Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_RECOVERY_RECEIPT_ENVELOPE_VERSION,
    record: parsed.record,
    signature: parsed.signature,
  });
}

export async function persistSignedRestorePrivateRecoveryReceipt(
  targetDir: string,
  keyFile: string,
  record: Readonly<RestorePrivateRecoveryReceiptRecord>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivateRecoveryReceiptEnvelope }>> {
  validateRecord(record);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await chmod(targetDir, 0o700);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_RECOVERY_RECEIPT_ENVELOPE_VERSION,
    record,
    signature: signRecord(key, record),
  }) satisfies SignedRestorePrivateRecoveryReceiptEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(targetDir, RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME);
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME}.${crypto.randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readFile(finalPath, 'utf8').catch(() => null);
      if (existing === serialized) return Object.freeze({ path: finalPath, created: false, envelope });
      throw new Error('Restore private recovery receipt already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function ensureSignedRestorePrivateRecoveryReceipt(
  input: Readonly<EnsureRestorePrivateRecoveryReceiptInput>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivateRecoveryReceiptEnvelope }>> {
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_RECOVERY_RECEIPT_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivateRecoveryReceipt(
      finalPath,
      input.keyFile,
      input.intentFile,
      input.plan,
      input.reconciliation,
    );
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }

  const record = await createRestorePrivateRecoveryReceiptRecord(input);
  try {
    return await persistSignedRestorePrivateRecoveryReceipt(input.targetDir, input.keyFile, record);
  } catch (error) {
    const existing = await readVerifiedRestorePrivateRecoveryReceipt(
      finalPath,
      input.keyFile,
      input.intentFile,
      input.plan,
      input.reconciliation,
    ).catch(() => null);
    if (existing) return Object.freeze({ path: finalPath, created: false, envelope: existing });
    throw error;
  }
}
