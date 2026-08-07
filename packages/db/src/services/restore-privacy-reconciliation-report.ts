import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RestorePrivacyLedgerEntry,
  RestorePrivacyReconciliationLedger,
} from './restore-privacy-ledger';
import {
  readVerifiedSignedRestorePrivacyLedger,
  restorePrivacyLedgerFileName,
  type SignedRestorePrivacyLedgerEnvelope,
} from './restore-privacy-ledger-storage';
import {
  readVerifiedRestorePrivacyEffectRecord,
  type RestorePrivacyEffectIdentity,
  type RestorePrivacyEffectRecord,
} from './restore-privacy-effect-journal';

export const RESTORE_PRIVACY_RECONCILIATION_REPORT_VERSION = 1 as const;

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const LEDGER_FILE_PREFIX = 'restore-privacy-ledger-';
const JOURNAL_FILE_PREFIX = 'privacy-effect-';

export type RestorePrivacyReconciliationStatus = 'BLOCKED' | 'REPLAY_REQUIRED' | 'CLEAR';
export type RestorePrivacyReconciliationSource = 'LEDGER' | 'JOURNAL';
export type RestorePrivacyReconciliationBlockerCode =
  | 'TRUSTED_LEDGER_MISSING'
  | 'OPEN_PENDING_INTENT'
  | 'LEDGER_ABORT_CONTRADICTION'
  | 'LEDGER_JOURNAL_IDENTITY_MISMATCH'
  | 'LEDGER_JOURNAL_COMMIT_TIME_MISMATCH'
  | 'JOURNAL_COMMIT_MISSING_FROM_LEDGER';

export interface RestorePrivacyReplayObligation extends RestorePrivacyEffectIdentity {
  readonly dbCommittedAt: string;
  readonly sources: readonly RestorePrivacyReconciliationSource[];
}

export interface RestorePrivacyReconciliationBlocker {
  readonly code: RestorePrivacyReconciliationBlockerCode;
  readonly executionId: string | null;
}

export interface RestorePrivacyReconciliationReport {
  readonly reportVersion: typeof RESTORE_PRIVACY_RECONCILIATION_REPORT_VERSION;
  readonly backupCutoff: string;
  readonly status: RestorePrivacyReconciliationStatus;
  readonly reconciliationReady: boolean;
  readonly promotionAllowed: false;
  readonly ledger: Readonly<{
    generatedAt: string;
    entriesFingerprint: string;
    entryCount: number;
  }> | null;
  readonly journalMarkerCount: number;
  readonly obligations: readonly Readonly<RestorePrivacyReplayObligation>[];
  readonly blockers: readonly Readonly<RestorePrivacyReconciliationBlocker>[];
}

export interface RestorePrivacyReconciliationStorageInput {
  readonly backupCutoff: string;
  readonly ledgerDir: string;
  readonly ledgerKeyFile: string;
  readonly journalDir: string;
  readonly journalKeyFile: string;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function fingerprintLedgerEntries(
  sinceExclusive: string,
  entries: readonly Readonly<RestorePrivacyLedgerEntry>[],
): `sha256:${string}` {
  const canonical = JSON.stringify({ ledgerVersion: 1, sinceExclusive, entries });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function ledgerEntrySortKey(entry: Readonly<RestorePrivacyLedgerEntry>): string {
  return [entry.dbCommittedAt, entry.tenantId, entry.athleteId, entry.executionId].join('\n');
}

function assertLedgerIntegrity(ledger: Readonly<RestorePrivacyReconciliationLedger>): void {
  if (ledger.ledgerVersion !== 1) throw new Error('Restore privacy ledger version is invalid');
  assertCanonicalTimestamp(ledger.sinceExclusive, 'Restore privacy ledger cutoff');
  assertCanonicalTimestamp(ledger.generatedAt, 'Restore privacy ledger generation time');
  if (ledger.generatedAt < ledger.sinceExclusive) {
    throw new Error('Restore privacy ledger generation time precedes its cutoff');
  }
  if (!FINGERPRINT.test(ledger.entriesFingerprint)) {
    throw new Error('Restore privacy ledger entries fingerprint is invalid');
  }

  const executionIds = new Set<string>();
  for (const entry of ledger.entries) {
    for (const [label, value] of [
      ['tenantId', entry.tenantId],
      ['athleteId', entry.athleteId],
      ['executionId', entry.executionId],
      ['approvalId', entry.approvalId],
      ['deletionRequestId', entry.deletionRequestId],
      ['policyVersion', entry.policyVersion],
    ] as const) assertNonEmpty(value, `Restore privacy ledger ${label}`);
    if (!Number.isInteger(entry.executionVersion) || entry.executionVersion < 1) {
      throw new Error('Restore privacy ledger executionVersion must be a positive integer');
    }
    if (!FINGERPRINT.test(entry.scopeFingerprint) || !FINGERPRINT.test(entry.capabilityFingerprint)) {
      throw new Error('Restore privacy ledger entry fingerprints are invalid');
    }
    assertCanonicalTimestamp(entry.dbCommittedAt, 'Restore privacy ledger DB commit time');
    if (entry.dbCommittedAt <= ledger.sinceExclusive || entry.dbCommittedAt > ledger.generatedAt) {
      throw new Error('Restore privacy ledger entry falls outside its observation window');
    }
    if (executionIds.has(entry.executionId)) {
      throw new Error('Restore privacy ledger contains a duplicate execution');
    }
    executionIds.add(entry.executionId);
  }

  const sorted = [...ledger.entries].sort((left, right) => ledgerEntrySortKey(left).localeCompare(ledgerEntrySortKey(right)));
  if (JSON.stringify(sorted) !== JSON.stringify(ledger.entries)) {
    throw new Error('Restore privacy ledger entries are not in canonical order');
  }
  if (fingerprintLedgerEntries(ledger.sinceExclusive, ledger.entries) !== ledger.entriesFingerprint) {
    throw new Error('Restore privacy ledger entries fingerprint does not match its entries');
  }
}

function identityFromLedgerEntry(entry: Readonly<RestorePrivacyLedgerEntry>): Readonly<RestorePrivacyEffectIdentity> {
  return Object.freeze({
    tenantId: entry.tenantId,
    athleteId: entry.athleteId,
    executionId: entry.executionId,
    approvalId: entry.approvalId,
    deletionRequestId: entry.deletionRequestId,
    executionVersion: entry.executionVersion,
    policyVersion: entry.policyVersion,
    scopeFingerprint: entry.scopeFingerprint,
    capabilityFingerprint: entry.capabilityFingerprint,
  });
}

function sameIdentity(
  left: Readonly<RestorePrivacyEffectIdentity>,
  right: Readonly<RestorePrivacyEffectIdentity>,
): boolean {
  return left.tenantId === right.tenantId
    && left.athleteId === right.athleteId
    && left.executionId === right.executionId
    && left.approvalId === right.approvalId
    && left.deletionRequestId === right.deletionRequestId
    && left.executionVersion === right.executionVersion
    && left.policyVersion === right.policyVersion
    && left.scopeFingerprint === right.scopeFingerprint
    && left.capabilityFingerprint === right.capabilityFingerprint;
}

function assertJournalPairConsistency(
  pending: Readonly<RestorePrivacyEffectRecord>,
  terminal: Readonly<RestorePrivacyEffectRecord>,
): void {
  if (pending.phase !== 'PENDING') throw new Error('Restore privacy effect journal pair is missing PENDING intent');
  if (terminal.phase === 'PENDING') throw new Error('Restore privacy effect journal terminal record is invalid');
  if (!sameIdentity(pending.effect, terminal.effect)) {
    throw new Error('Restore privacy effect terminal marker does not match its PENDING identity');
  }
  if (terminal.recordedAt < pending.recordedAt) {
    throw new Error('Restore privacy effect terminal marker precedes its PENDING intent');
  }
}

function addObligation(
  obligations: Map<string, RestorePrivacyReplayObligation>,
  effect: Readonly<RestorePrivacyEffectIdentity>,
  dbCommittedAt: string,
  source: RestorePrivacyReconciliationSource,
): void {
  const existing = obligations.get(effect.executionId);
  if (existing) {
    const sources = [...new Set([...existing.sources, source])].sort() as RestorePrivacyReconciliationSource[];
    obligations.set(effect.executionId, Object.freeze({ ...existing, sources: Object.freeze(sources) }));
    return;
  }
  obligations.set(effect.executionId, Object.freeze({
    ...effect,
    dbCommittedAt,
    sources: Object.freeze([source]),
  }));
}

export function buildRestorePrivacyReconciliationReport(
  backupCutoff: string,
  ledgerEnvelope: Readonly<SignedRestorePrivacyLedgerEnvelope> | null,
  journalRecords: readonly Readonly<RestorePrivacyEffectRecord>[],
): Readonly<RestorePrivacyReconciliationReport> {
  assertCanonicalTimestamp(backupCutoff, 'Restore backup cutoff');
  const blockers: RestorePrivacyReconciliationBlocker[] = [];
  const obligations = new Map<string, RestorePrivacyReplayObligation>();
  const ledgerEntries = new Map<string, Readonly<RestorePrivacyLedgerEntry>>();

  if (!ledgerEnvelope) {
    blockers.push(Object.freeze({ code: 'TRUSTED_LEDGER_MISSING', executionId: null }));
  } else {
    assertLedgerIntegrity(ledgerEnvelope.ledger);
    if (ledgerEnvelope.ledger.sinceExclusive !== backupCutoff) {
      throw new Error('Restore privacy ledger cutoff does not match the selected backup');
    }
    for (const entry of ledgerEnvelope.ledger.entries) {
      ledgerEntries.set(entry.executionId, entry);
      addObligation(obligations, identityFromLedgerEntry(entry), entry.dbCommittedAt, 'LEDGER');
    }
  }

  const journalByExecution = new Map<string, {
    pending?: Readonly<RestorePrivacyEffectRecord>;
    terminal?: Readonly<RestorePrivacyEffectRecord>;
  }>();
  for (const record of journalRecords) {
    const current = journalByExecution.get(record.effect.executionId) ?? {};
    if (record.phase === 'PENDING') {
      if (current.pending) throw new Error('Restore privacy effect journal contains duplicate PENDING records');
      current.pending = record;
    } else {
      if (current.terminal) throw new Error('Restore privacy effect journal contains duplicate terminal records');
      current.terminal = record;
    }
    journalByExecution.set(record.effect.executionId, current);
  }

  for (const [executionId, pair] of [...journalByExecution.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!pair.pending) throw new Error('Restore privacy effect terminal record is missing its PENDING intent');
    if (!pair.terminal) {
      blockers.push(Object.freeze({ code: 'OPEN_PENDING_INTENT', executionId }));
      continue;
    }
    assertJournalPairConsistency(pair.pending, pair.terminal);

    const ledgerEntry = ledgerEntries.get(executionId);
    if (pair.terminal.phase === 'ABORTED') {
      if (ledgerEntry) blockers.push(Object.freeze({ code: 'LEDGER_ABORT_CONTRADICTION', executionId }));
      continue;
    }
    if (pair.terminal.phase !== 'COMMITTED') throw new Error('Restore privacy effect terminal phase is invalid');

    const relevantToBackup = pair.terminal.dbCommittedAt > backupCutoff;
    if (!relevantToBackup) continue;

    if (ledgerEntry) {
      const ledgerIdentity = identityFromLedgerEntry(ledgerEntry);
      if (!sameIdentity(ledgerIdentity, pair.terminal.effect)) {
        blockers.push(Object.freeze({ code: 'LEDGER_JOURNAL_IDENTITY_MISMATCH', executionId }));
        continue;
      }
      if (ledgerEntry.dbCommittedAt !== pair.terminal.dbCommittedAt) {
        blockers.push(Object.freeze({ code: 'LEDGER_JOURNAL_COMMIT_TIME_MISMATCH', executionId }));
        continue;
      }
      addObligation(obligations, pair.terminal.effect, pair.terminal.dbCommittedAt, 'JOURNAL');
      continue;
    }

    if (ledgerEnvelope && pair.terminal.dbCommittedAt <= ledgerEnvelope.ledger.generatedAt) {
      blockers.push(Object.freeze({ code: 'JOURNAL_COMMIT_MISSING_FROM_LEDGER', executionId }));
      continue;
    }
    addObligation(obligations, pair.terminal.effect, pair.terminal.dbCommittedAt, 'JOURNAL');
  }

  const orderedObligations = Object.freeze([...obligations.values()].sort((left, right) => (
    [left.dbCommittedAt, left.tenantId, left.athleteId, left.executionId].join('\n')
      .localeCompare([right.dbCommittedAt, right.tenantId, right.athleteId, right.executionId].join('\n'))
  )));
  const orderedBlockers = Object.freeze(blockers.sort((left, right) => (
    [left.code, left.executionId ?? ''].join('\n').localeCompare([right.code, right.executionId ?? ''].join('\n'))
  )));
  const status: RestorePrivacyReconciliationStatus = orderedBlockers.length > 0
    ? 'BLOCKED'
    : orderedObligations.length > 0
      ? 'REPLAY_REQUIRED'
      : 'CLEAR';

  return Object.freeze({
    reportVersion: RESTORE_PRIVACY_RECONCILIATION_REPORT_VERSION,
    backupCutoff,
    status,
    reconciliationReady: status !== 'BLOCKED',
    promotionAllowed: false,
    ledger: ledgerEnvelope ? Object.freeze({
      generatedAt: ledgerEnvelope.ledger.generatedAt,
      entriesFingerprint: ledgerEnvelope.ledger.entriesFingerprint,
      entryCount: ledgerEnvelope.ledger.entries.length,
    }) : null,
    journalMarkerCount: journalRecords.length,
    obligations: orderedObligations,
    blockers: orderedBlockers,
  });
}

async function latestVerifiedLedgerForCutoff(
  ledgerDir: string,
  ledgerKeyFile: string,
  backupCutoff: string,
): Promise<Readonly<SignedRestorePrivacyLedgerEnvelope> | null> {
  const entries = await readdir(ledgerDir, { withFileTypes: true });
  const candidates: Array<{ name: string; envelope: Readonly<SignedRestorePrivacyLedgerEnvelope> }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.startsWith(LEDGER_FILE_PREFIX) || !entry.name.endsWith('.json')) continue;
    const envelope = await readVerifiedSignedRestorePrivacyLedger(join(ledgerDir, entry.name), ledgerKeyFile);
    assertLedgerIntegrity(envelope.ledger);
    if (restorePrivacyLedgerFileName(envelope.ledger) !== entry.name) {
      throw new Error('Restore privacy ledger file name does not match its signed content');
    }
    if (envelope.ledger.sinceExclusive === backupCutoff) candidates.push({ name: entry.name, envelope });
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => (
    right.envelope.ledger.generatedAt.localeCompare(left.envelope.ledger.generatedAt)
      || right.name.localeCompare(left.name)
  ));
  const latest = candidates[0]!;
  const conflicting = candidates.filter((candidate) => (
    candidate.envelope.ledger.generatedAt === latest.envelope.ledger.generatedAt
      && candidate.envelope.ledger.entriesFingerprint !== latest.envelope.ledger.entriesFingerprint
  ));
  if (conflicting.length > 0) {
    throw new Error('Conflicting restore privacy ledgers exist for the latest observation time');
  }
  return latest.envelope;
}

async function verifiedJournalRecords(
  journalDir: string,
  journalKeyFile: string,
): Promise<readonly Readonly<RestorePrivacyEffectRecord>[]> {
  const entries = await readdir(journalDir, { withFileTypes: true });
  const records: RestorePrivacyEffectRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.startsWith(JOURNAL_FILE_PREFIX) || !entry.name.endsWith('.json')) continue;
    const envelope = await readVerifiedRestorePrivacyEffectRecord(join(journalDir, entry.name), journalKeyFile);
    records.push(envelope.record);
  }
  return Object.freeze(records);
}

/**
 * Builds a read-only disaster-recovery privacy report from external durable sources only.
 * No live database and no restore-staging data mutation is required or performed.
 */
export async function createRestorePrivacyReconciliationReportFromStorage(
  input: RestorePrivacyReconciliationStorageInput,
): Promise<Readonly<RestorePrivacyReconciliationReport>> {
  assertCanonicalTimestamp(input.backupCutoff, 'Restore backup cutoff');
  const [ledger, journalRecords] = await Promise.all([
    latestVerifiedLedgerForCutoff(input.ledgerDir, input.ledgerKeyFile, input.backupCutoff),
    verifiedJournalRecords(input.journalDir, input.journalKeyFile),
  ]);
  return buildRestorePrivacyReconciliationReport(input.backupCutoff, ledger, journalRecords);
}
