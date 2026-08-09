import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SignedRestorePrivatePromotionSwitchJournalEnvelope } from './restore-private-promotion-switch-journal';
import type { RestorePrivatePromotionSwitchRole } from './restore-private-promotion-switch-intent';

export const RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_EVENT_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_EVENT_ENVELOPE_VERSION = 1 as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-switch-execution-event:v1\n';
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type RestorePrivatePromotionSwitchExecutionPhase =
  | 'CUTOVER_STARTED'
  | 'CANDIDATE_SELECTED'
  | 'COMPLETED'
  | 'ROLLBACK_STARTED'
  | 'ROLLBACK_SELECTED'
  | 'ROLLBACK_VERIFIED';

export interface RestorePrivatePromotionSwitchExecutionEventRecord {
  readonly eventVersion: typeof RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_EVENT_VERSION;
  readonly sequence: 1 | 2 | 3 | 4 | 5;
  readonly phase: RestorePrivatePromotionSwitchExecutionPhase;
  readonly recordedAt: string;
  readonly journalFingerprint: `sha256:${string}`;
  readonly journalSignature: `hmac-sha256:${string}`;
  readonly candidateSetId: string;
  readonly previousEventSignature: `hmac-sha256:${string}` | null;
  readonly targetVolumeSet: 'CANDIDATE' | 'ROLLBACK';
  readonly productionMutationStarted: true;
  readonly promotionExecuted: boolean;
  readonly terminal: boolean;
}

export interface SignedRestorePrivatePromotionSwitchExecutionEventEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_EVENT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionSwitchExecutionEventRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface RestorePrivatePromotionCurrentVolumeSet {
  readonly libsql: string;
  readonly reports: string;
  readonly tenantExports: string;
  readonly dataSubjectDelivery: string;
}

export type RestorePrivatePromotionCurrentVolumeSetClass =
  | 'CANDIDATE'
  | 'ROLLBACK'
  | 'MIXED_KNOWN'
  | 'UNKNOWN';

export type RestorePrivatePromotionSwitchExecutionAssessmentStatus =
  | 'READY_TO_START'
  | 'READY_TO_SELECT_CANDIDATE'
  | 'RECOVER_CANDIDATE_SELECTION'
  | 'VERIFY_CANDIDATE'
  | 'READY_TO_SELECT_ROLLBACK'
  | 'RECOVER_ROLLBACK_SELECTION'
  | 'VERIFY_ROLLBACK'
  | 'COMPLETED'
  | 'ROLLED_BACK'
  | 'BLOCKED';

export interface RestorePrivatePromotionSwitchExecutionAssessment {
  readonly assessmentVersion: 1;
  readonly status: RestorePrivatePromotionSwitchExecutionAssessmentStatus;
  readonly reason: string;
  readonly currentVolumeSet: RestorePrivatePromotionCurrentVolumeSetClass;
  readonly lastPhase: RestorePrivatePromotionSwitchExecutionPhase | null;
  readonly nextAllowedEvents: readonly RestorePrivatePromotionSwitchExecutionPhase[];
  readonly candidateSetId: string;
  readonly journalFingerprint: `sha256:${string}`;
  readonly productionMutationAllowed: boolean;
  readonly promotionExecuted: boolean;
}

const ROLE_ORDER: readonly RestorePrivatePromotionSwitchRole[] = Object.freeze([
  'LIBSQL',
  'REPORTS',
  'TENANT_EXPORTS',
  'DATA_SUBJECT_DELIVERY',
]);

const PHASE_FILE: Readonly<Record<RestorePrivatePromotionSwitchExecutionPhase, string>> = Object.freeze({
  CUTOVER_STARTED: 'promotion-switch-cutover-started.json',
  CANDIDATE_SELECTED: 'promotion-switch-candidate-selected.json',
  COMPLETED: 'promotion-switch-completed.json',
  ROLLBACK_STARTED: 'promotion-switch-rollback-started.json',
  ROLLBACK_SELECTED: 'promotion-switch-rollback-selected.json',
  ROLLBACK_VERIFIED: 'promotion-switch-rollback-verified.json',
});

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSafeDockerVolumeName(value: string, label: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${label} is not a safe Docker volume name`);
}

function verifyJournal(journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>): void {
  if (journal.envelopeVersion !== 1 || journal.record.journalVersion !== 1 || journal.record.phase !== 'PENDING') {
    throw new Error('Restore promotion switch execution requires a verified PENDING journal');
  }
  if (!HMAC_SHA256_SIGNATURE.test(journal.signature) || !SHA256_FINGERPRINT.test(journal.record.journalFingerprint)) {
    throw new Error('Restore promotion switch execution journal identity is invalid');
  }
  if (
    journal.record.journalRequiredBeforeMutation !== true
    || journal.record.productionSwitchAuthorized !== true
    || journal.record.productionMutationStarted !== false
    || journal.record.promotionExecuted !== false
    || journal.record.rollbackVolumesMustRemain !== true
  ) {
    throw new Error('Restore promotion switch execution journal safety state is invalid');
  }
  if (journal.record.volumes.length !== 4) throw new Error('Restore promotion switch execution requires four journal volumes');
  for (const [index, role] of ROLE_ORDER.entries()) {
    const volume = journal.record.volumes[index];
    if (!volume || volume.role !== role) throw new Error('Restore promotion switch execution journal volume order is invalid');
    assertSafeDockerVolumeName(volume.candidateVolumeName, `Candidate ${role} volume`);
    assertSafeDockerVolumeName(volume.rollbackVolumeName, `Rollback ${role} volume`);
  }
}

function targetSetForPhase(phase: RestorePrivatePromotionSwitchExecutionPhase): 'CANDIDATE' | 'ROLLBACK' {
  if (phase === 'CUTOVER_STARTED' || phase === 'CANDIDATE_SELECTED' || phase === 'COMPLETED') return 'CANDIDATE';
  return 'ROLLBACK';
}

function terminalForPhase(phase: RestorePrivatePromotionSwitchExecutionPhase): boolean {
  return phase === 'COMPLETED' || phase === 'ROLLBACK_VERIFIED';
}

function legalNextPhases(
  events: readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[],
): readonly RestorePrivatePromotionSwitchExecutionPhase[] {
  if (events.length === 0) return Object.freeze(['CUTOVER_STARTED']);
  const last = events.at(-1)?.record.phase;
  if (last === 'CUTOVER_STARTED') return Object.freeze(['CANDIDATE_SELECTED', 'ROLLBACK_STARTED']);
  if (last === 'CANDIDATE_SELECTED') return Object.freeze(['COMPLETED', 'ROLLBACK_STARTED']);
  if (last === 'ROLLBACK_STARTED') return Object.freeze(['ROLLBACK_SELECTED']);
  if (last === 'ROLLBACK_SELECTED') return Object.freeze(['ROLLBACK_VERIFIED']);
  return Object.freeze([]);
}

function validateRecord(
  record: Readonly<RestorePrivatePromotionSwitchExecutionEventRecord>,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
): void {
  if (record.eventVersion !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > 5) {
    throw new Error('Restore promotion switch execution event version or sequence is invalid');
  }
  assertCanonicalTimestamp(record.recordedAt, 'Restore promotion switch execution event recordedAt');
  if (record.recordedAt < journal.record.startedAt) {
    throw new Error('Restore promotion switch execution event cannot precede journal start');
  }
  if (
    record.journalFingerprint !== journal.record.journalFingerprint
    || record.journalSignature !== journal.signature
    || record.candidateSetId !== journal.record.candidateSetId
  ) {
    throw new Error('Restore promotion switch execution event does not match durable journal');
  }
  if (record.previousEventSignature !== null && !HMAC_SHA256_SIGNATURE.test(record.previousEventSignature)) {
    throw new Error('Restore promotion switch execution previous event signature is invalid');
  }
  if (
    record.targetVolumeSet !== targetSetForPhase(record.phase)
    || record.productionMutationStarted !== true
    || record.promotionExecuted !== (record.phase === 'COMPLETED')
    || record.terminal !== terminalForPhase(record.phase)
  ) {
    throw new Error('Restore promotion switch execution event safety state is invalid');
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion switch execution key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Restore promotion switch execution key must be a regular file');
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Restore promotion switch execution key must decode to exactly 32 bytes');
  return key;
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionSwitchExecutionEventRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({ envelopeVersion: 1, record })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivatePromotionSwitchExecutionEventRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

async function readEventIfPresent(
  targetDir: string,
  phase: RestorePrivatePromotionSwitchExecutionPhase,
  key: Buffer,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
): Promise<Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null> {
  const path = join(targetDir, PHASE_FILE[phase]);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Restore promotion switch execution event is unsafe: ${path}`);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>;
  if (parsed.envelopeVersion !== 1 || !parsed.record || typeof parsed.signature !== 'string') {
    throw new Error('Restore promotion switch execution event envelope is invalid');
  }
  validateRecord(parsed.record, journal);
  if (!HMAC_SHA256_SIGNATURE.test(parsed.signature)) throw new Error('Restore promotion switch execution event signature is invalid');
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore promotion switch execution event signature verification failed');
  }
  return Object.freeze({ envelopeVersion: 1, record: parsed.record, signature: parsed.signature });
}

function buildEventChain(
  started: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null,
  candidate: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null,
  completed: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null,
  rollbackStarted: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null,
  rollbackSelected: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null,
  rollbackVerified: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null,
): readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[] {
  const anyAfterStart = candidate || completed || rollbackStarted || rollbackSelected || rollbackVerified;
  if (!started) {
    if (anyAfterStart) throw new Error('Restore promotion switch execution events are missing CUTOVER_STARTED evidence');
    return Object.freeze([]);
  }
  if (completed && (!candidate || rollbackStarted || rollbackSelected || rollbackVerified)) {
    throw new Error('Restore promotion switch completion evidence conflicts with rollback or missing candidate selection');
  }
  if (rollbackSelected && !rollbackStarted) {
    throw new Error('Restore promotion switch rollback selection lacks ROLLBACK_STARTED evidence');
  }
  if (rollbackVerified && !rollbackSelected) {
    throw new Error('Restore promotion switch rollback verification lacks rollback selection evidence');
  }

  const chain: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[] = [started];
  if (candidate) chain.push(candidate);
  if (completed) chain.push(completed);
  if (rollbackStarted) chain.push(rollbackStarted);
  if (rollbackSelected) chain.push(rollbackSelected);
  if (rollbackVerified) chain.push(rollbackVerified);
  return Object.freeze(chain);
}

export async function readVerifiedRestorePrivatePromotionSwitchExecutionEvents(
  targetDir: string,
  keyFile: string,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
): Promise<readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[]> {
  verifyJournal(journal);
  if (!isAbsolute(targetDir)) throw new Error('Restore promotion switch execution directory must be absolute');
  const key = await readSigningKey(keyFile);
  const started = await readEventIfPresent(targetDir, 'CUTOVER_STARTED', key, journal);
  const candidate = await readEventIfPresent(targetDir, 'CANDIDATE_SELECTED', key, journal);
  const completed = await readEventIfPresent(targetDir, 'COMPLETED', key, journal);
  const rollbackStarted = await readEventIfPresent(targetDir, 'ROLLBACK_STARTED', key, journal);
  const rollbackSelected = await readEventIfPresent(targetDir, 'ROLLBACK_SELECTED', key, journal);
  const rollbackVerified = await readEventIfPresent(targetDir, 'ROLLBACK_VERIFIED', key, journal);
  const events = buildEventChain(started, candidate, completed, rollbackStarted, rollbackSelected, rollbackVerified);

  let previous: Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope> | null = null;
  for (const [index, event] of events.entries()) {
    if (event.record.sequence !== index + 1) throw new Error('Restore promotion switch execution event sequence is not contiguous');
    if (event.record.previousEventSignature !== (previous?.signature ?? null)) {
      throw new Error('Restore promotion switch execution event signature chain is broken');
    }
    if (!legalNextPhases(events.slice(0, index)).includes(event.record.phase)) {
      throw new Error('Restore promotion switch execution event transition is invalid');
    }
    previous = event;
  }
  return events;
}

export async function ensureSignedRestorePrivatePromotionSwitchExecutionEvent(
  targetDir: string,
  keyFile: string,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
  phase: RestorePrivatePromotionSwitchExecutionPhase,
  recordedAt: string,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSwitchExecutionEventEnvelope }>> {
  verifyJournal(journal);
  if (!isAbsolute(targetDir)) throw new Error('Restore promotion switch execution directory must be absolute');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await chmod(targetDir, 0o700);
  const events = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(targetDir, keyFile, journal);
  const existing = events.find((event) => event.record.phase === phase);
  if (existing) return Object.freeze({ path: join(targetDir, PHASE_FILE[phase]), created: false, envelope: existing });
  if (!legalNextPhases(events).includes(phase)) {
    throw new Error(`Restore promotion switch execution phase ${phase} is not allowed after current evidence`);
  }
  if (events.length >= 5) throw new Error('Restore promotion switch execution event chain is too long');
  assertCanonicalTimestamp(recordedAt, 'Restore promotion switch execution event recordedAt');
  const previous = events.at(-1) ?? null;
  const record = Object.freeze({
    eventVersion: 1 as const,
    sequence: (events.length + 1) as 1 | 2 | 3 | 4 | 5,
    phase,
    recordedAt,
    journalFingerprint: journal.record.journalFingerprint,
    journalSignature: journal.signature,
    candidateSetId: journal.record.candidateSetId,
    previousEventSignature: previous?.signature ?? null,
    targetVolumeSet: targetSetForPhase(phase),
    productionMutationStarted: true as const,
    promotionExecuted: phase === 'COMPLETED',
    terminal: terminalForPhase(phase),
  });
  validateRecord(record, journal);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({ envelopeVersion: 1 as const, record, signature: signRecord(key, record) });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const path = join(targetDir, PHASE_FILE[phase]);
  const temp = join(targetDir, `.${PHASE_FILE[phase]}.${randomUUID()}.tmp`);
  await writeFile(temp, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(temp, path);
      return Object.freeze({ path, created: true, envelope });
    } catch (error) {
      const current = await readFile(path, 'utf8').catch(() => null);
      if (current === serialized) return Object.freeze({ path, created: false, envelope });
      throw new Error('Restore promotion switch execution event already exists with different content', { cause: error });
    }
  } finally {
    await rm(temp, { force: true });
  }
}

function classifyCurrentVolumeSet(
  current: Readonly<RestorePrivatePromotionCurrentVolumeSet>,
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
): RestorePrivatePromotionCurrentVolumeSetClass {
  for (const [value, label] of [
    [current.libsql, 'libSQL'],
    [current.reports, 'reports'],
    [current.tenantExports, 'tenant exports'],
    [current.dataSubjectDelivery, 'data-subject delivery'],
  ] as const) assertSafeDockerVolumeName(value, `Current ${label} volume`);
  const actual = [current.libsql, current.reports, current.tenantExports, current.dataSubjectDelivery];
  const candidate = journal.record.volumes.map((item) => item.candidateVolumeName);
  const rollback = journal.record.volumes.map((item) => item.rollbackVolumeName);
  if (actual.every((name, index) => name === candidate[index])) return 'CANDIDATE';
  if (actual.every((name, index) => name === rollback[index])) return 'ROLLBACK';
  if (actual.every((name, index) => name === candidate[index] || name === rollback[index])) return 'MIXED_KNOWN';
  return 'UNKNOWN';
}

function blocked(
  base: Omit<RestorePrivatePromotionSwitchExecutionAssessment, 'status' | 'reason' | 'productionMutationAllowed' | 'promotionExecuted'>,
  reason: string,
): Readonly<RestorePrivatePromotionSwitchExecutionAssessment> {
  return Object.freeze({ ...base, status: 'BLOCKED', reason, productionMutationAllowed: false, promotionExecuted: false });
}

export function assessRestorePrivatePromotionSwitchExecution(
  journal: Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope>,
  events: readonly Readonly<SignedRestorePrivatePromotionSwitchExecutionEventEnvelope>[],
  current: Readonly<RestorePrivatePromotionCurrentVolumeSet>,
): Readonly<RestorePrivatePromotionSwitchExecutionAssessment> {
  verifyJournal(journal);
  const currentVolumeSet = classifyCurrentVolumeSet(current, journal);
  const lastPhase = events.at(-1)?.record.phase ?? null;
  const nextAllowedEvents = legalNextPhases(events);
  const base = {
    assessmentVersion: 1 as const,
    currentVolumeSet,
    lastPhase,
    nextAllowedEvents,
    candidateSetId: journal.record.candidateSetId,
    journalFingerprint: journal.record.journalFingerprint,
  };
  if (currentVolumeSet === 'UNKNOWN') return blocked(base, 'ACTIVE_VOLUME_SET_UNKNOWN');

  if (events.length === 0) {
    if (currentVolumeSet === 'ROLLBACK') {
      return Object.freeze({ ...base, status: 'READY_TO_START', reason: 'ROLLBACK_SET_ACTIVE_WITHOUT_EXECUTION_EVENTS', productionMutationAllowed: true, promotionExecuted: false });
    }
    return blocked(base, currentVolumeSet === 'MIXED_KNOWN'
      ? 'MIXED_VOLUME_SET_WITHOUT_CUTOVER_STARTED_EVIDENCE'
      : 'CANDIDATE_ACTIVE_WITHOUT_CUTOVER_STARTED_EVIDENCE');
  }

  if (lastPhase === 'CUTOVER_STARTED') {
    if (currentVolumeSet === 'ROLLBACK') {
      return Object.freeze({ ...base, status: 'READY_TO_SELECT_CANDIDATE', reason: 'CUTOVER_STARTED_AND_ROLLBACK_SET_STILL_ACTIVE', productionMutationAllowed: true, promotionExecuted: false });
    }
    if (currentVolumeSet === 'MIXED_KNOWN') {
      return Object.freeze({ ...base, status: 'READY_TO_SELECT_CANDIDATE', reason: 'CUTOVER_STARTED_WITH_PARTIAL_KNOWN_CANDIDATE_SELECTION', productionMutationAllowed: true, promotionExecuted: false });
    }
    return Object.freeze({ ...base, status: 'RECOVER_CANDIDATE_SELECTION', reason: 'CANDIDATE_SET_ACTIVE_BEFORE_SELECTION_EVENT_WAS_PERSISTED', productionMutationAllowed: false, promotionExecuted: false });
  }

  if (lastPhase === 'CANDIDATE_SELECTED') {
    if (currentVolumeSet === 'CANDIDATE') {
      return Object.freeze({ ...base, status: 'VERIFY_CANDIDATE', reason: 'CANDIDATE_SET_ACTIVE_AND_SELECTION_EVIDENCE_PRESENT', productionMutationAllowed: false, promotionExecuted: false });
    }
    return blocked(base, 'ACTIVE_SET_CONFLICTS_WITH_CANDIDATE_SELECTED_EVIDENCE');
  }

  if (lastPhase === 'ROLLBACK_STARTED') {
    if (currentVolumeSet === 'ROLLBACK') {
      return Object.freeze({ ...base, status: 'RECOVER_ROLLBACK_SELECTION', reason: 'ROLLBACK_SET_ACTIVE_BEFORE_SELECTION_EVENT_WAS_PERSISTED', productionMutationAllowed: false, promotionExecuted: false });
    }
    if (currentVolumeSet === 'CANDIDATE' || currentVolumeSet === 'MIXED_KNOWN') {
      return Object.freeze({
        ...base,
        status: 'READY_TO_SELECT_ROLLBACK',
        reason: currentVolumeSet === 'CANDIDATE'
          ? 'ROLLBACK_STARTED_AND_CANDIDATE_SET_STILL_ACTIVE'
          : 'ROLLBACK_STARTED_WITH_PARTIAL_KNOWN_ROLLBACK_SELECTION',
        productionMutationAllowed: true,
        promotionExecuted: false,
      });
    }
  }

  if (lastPhase === 'ROLLBACK_SELECTED') {
    if (currentVolumeSet === 'ROLLBACK') {
      return Object.freeze({ ...base, status: 'VERIFY_ROLLBACK', reason: 'ROLLBACK_SET_ACTIVE_AND_SELECTION_EVIDENCE_PRESENT', productionMutationAllowed: false, promotionExecuted: false });
    }
    return blocked(base, 'ACTIVE_SET_CONFLICTS_WITH_ROLLBACK_SELECTED_EVIDENCE');
  }

  if (lastPhase === 'ROLLBACK_VERIFIED') {
    if (currentVolumeSet === 'ROLLBACK') {
      return Object.freeze({ ...base, status: 'ROLLED_BACK', reason: 'ROLLBACK_SET_VERIFIED_AFTER_FAILED_CUTOVER', productionMutationAllowed: false, promotionExecuted: false });
    }
    return blocked(base, 'ACTIVE_SET_CONFLICTS_WITH_ROLLBACK_TERMINAL_EVIDENCE');
  }

  if (lastPhase === 'COMPLETED') {
    if (currentVolumeSet === 'CANDIDATE') {
      return Object.freeze({ ...base, status: 'COMPLETED', reason: 'CANDIDATE_SET_ACTIVE_WITH_COMPLETION_EVIDENCE', productionMutationAllowed: false, promotionExecuted: true });
    }
    return blocked(base, 'ACTIVE_SET_CONFLICTS_WITH_COMPLETION_EVIDENCE');
  }

  return blocked(base, 'UNRECOGNIZED_EXECUTION_STATE');
}
