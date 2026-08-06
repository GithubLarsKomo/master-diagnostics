import { createHash } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
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
  readonly completedAt: string;
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
 * Builds the read-only privacy reconciliation obligations that occurred after one backup snapshot.
 *
 * The result intentionally contains only technical identifiers and immutable policy fingerprints.
 * It is not yet the external durable ledger required for productive restore; it is the canonical
 * source contract that such a ledger must persist outside the backup history.
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
    completedAt: athleteAnonymizationExecutions.completedAt,
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
      eq(athleteAnonymizationExecutions.status, 'COMPLETED'),
      gt(athleteAnonymizationExecutions.completedAt, sinceExclusive),
    ))
    .orderBy(
      asc(athleteAnonymizationExecutions.completedAt),
      asc(athleteAnonymizationExecutions.tenantId),
      asc(athleteAnonymizationExecutions.athleteId),
      asc(athleteAnonymizationExecutions.id),
    );

  const entries = Object.freeze(rows.map((row) => {
    if (!row.completedAt) throw new Error('Completed anonymization execution is missing completedAt');
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
      completedAt: row.completedAt,
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
