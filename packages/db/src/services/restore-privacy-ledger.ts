import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteAnonymizationApprovals,
  athleteAnonymizationExecutions,
} from '../schema';

export const RESTORE_PRIVACY_LEDGER_VERSION = 1 as const;

export interface RestorePrivacyLedgerEntry {
  readonly tenantId: string;
  readonly athleteId: string;
  readonly executionId: string;
  readonly approvalId: string;
  readonly deletionRequestId: string;
  readonly executionVersion: number;
  readonly policyVersion: string;
  readonly scopeFingerprint: string;
  readonly capabilityFingerprint: string;
  readonly dbCommittedAt: string;
}

export interface RestorePrivacyReconciliationLedger {
  readonly ledgerVersion: typeof RESTORE_PRIVACY_LEDGER_VERSION;
  readonly sinceExclusive: string;
  readonly generatedAt: string;
  readonly entriesFingerprint: `sha256:${string}`;
  readonly entries: readonly Readonly<RestorePrivacyLedgerEntry>[];
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid ISO-8601 timestamp`);
}

function fingerprintEntries(
  sinceExclusive: string,
  entries: readonly Readonly<RestorePrivacyLedgerEntry>[],
): `sha256:${string}` {
  const canonical = JSON.stringify({
    ledgerVersion: RESTORE_PRIVACY_LEDGER_VERSION,
    sinceExclusive,
    entries,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Builds the read-only privacy reconciliation obligations that became irreversible after one backup snapshot.
 *
 * DB_COMMITTED is the privacy-effective checkpoint: the subject data mutation has already happened even if
 * external artifact purge/final completion is still pending. The external durable ledger must therefore be
 * able to record both DB_COMMITTED and COMPLETED executions without waiting for the final completion state.
 *
 * The result intentionally contains only technical identifiers and immutable policy fingerprints. It is not
 * yet the external durable ledger required for productive restore; it is the canonical source contract that
 * such a ledger must persist outside the backup history.
 */
export async function getRestorePrivacyReconciliationLedger(
  db: Database,
  sinceExclusive: string,
  generatedAt = new Date().toISOString(),
): Promise<Readonly<RestorePrivacyReconciliationLedger>> {
  assertIsoTimestamp(sinceExclusive, 'Restore privacy ledger cutoff');
  assertIsoTimestamp(generatedAt, 'Restore privacy ledger generation time');
  if (Date.parse(generatedAt) < Date.parse(sinceExclusive)) {
    throw new Error('Restore privacy ledger generation time must not precede its cutoff');
  }

  const rows = await db.select({
    tenantId: athleteAnonymizationExecutions.tenantId,
    athleteId: athleteAnonymizationExecutions.athleteId,
    executionId: athleteAnonymizationExecutions.id,
    approvalId: athleteAnonymizationExecutions.approvalId,
    executionVersion: athleteAnonymizationExecutions.executionVersion,
    dbCommittedAt: athleteAnonymizationExecutions.dbCommittedAt,
    deletionRequestId: athleteAnonymizationApprovals.deletionRequestId,
    policyVersion: athleteAnonymizationApprovals.policyVersion,
    scopeFingerprint: athleteAnonymizationApprovals.scopeFingerprint,
    capabilityFingerprint: athleteAnonymizationApprovals.capabilityFingerprint,
  }).from(athleteAnonymizationExecutions)
    .innerJoin(athleteAnonymizationApprovals, and(
      eq(athleteAnonymizationApprovals.id, athleteAnonymizationExecutions.approvalId),
      eq(athleteAnonymizationApprovals.tenantId, athleteAnonymizationExecutions.tenantId),
      eq(athleteAnonymizationApprovals.athleteId, athleteAnonymizationExecutions.athleteId),
    ))
    .where(and(
      inArray(athleteAnonymizationExecutions.status, ['DB_COMMITTED', 'COMPLETED']),
      gt(athleteAnonymizationExecutions.dbCommittedAt, sinceExclusive),
    ))
    .orderBy(
      asc(athleteAnonymizationExecutions.dbCommittedAt),
      asc(athleteAnonymizationExecutions.tenantId),
      asc(athleteAnonymizationExecutions.athleteId),
      asc(athleteAnonymizationExecutions.id),
    );

  const entries = Object.freeze(rows.map((row) => {
    if (!row.dbCommittedAt) throw new Error('Privacy-effective anonymization execution is missing dbCommittedAt');
    return Object.freeze({
      tenantId: row.tenantId,
      athleteId: row.athleteId,
      executionId: row.executionId,
      approvalId: row.approvalId,
      deletionRequestId: row.deletionRequestId,
      executionVersion: row.executionVersion,
      policyVersion: row.policyVersion,
      scopeFingerprint: row.scopeFingerprint,
      capabilityFingerprint: row.capabilityFingerprint,
      dbCommittedAt: row.dbCommittedAt,
    });
  }));

  return Object.freeze({
    ledgerVersion: RESTORE_PRIVACY_LEDGER_VERSION,
    sinceExclusive,
    generatedAt,
    entriesFingerprint: fingerprintEntries(sinceExclusive, entries),
    entries,
  });
}
