import { createHash } from 'node:crypto';
import { and, asc, gt, inArray, lte } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteAnonymizationExecutions } from '../schema';

export const RESTORE_PRIVACY_LEDGER_VERSION = 1 as const;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface RestorePrivacyLedgerEntry {
  readonly tenantId: string;
  readonly athleteId: string;
  readonly executionId: string;
  readonly dbCommittedAt: string;
  readonly executionStatus: 'DB_COMMITTED' | 'COMPLETED';
}

export interface RestorePrivacyReconciliationLedger {
  readonly ledgerVersion: typeof RESTORE_PRIVACY_LEDGER_VERSION;
  readonly backupCreatedAt: string;
  readonly generatedAt: string;
  readonly entryCount: number;
  readonly entries: readonly Readonly<RestorePrivacyLedgerEntry>[];
  readonly fingerprint: `sha256:${string}`;
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function canonicalPayload(
  backupCreatedAt: string,
  generatedAt: string,
  entries: readonly Readonly<RestorePrivacyLedgerEntry>[],
) {
  return {
    ledgerVersion: RESTORE_PRIVACY_LEDGER_VERSION,
    backupCreatedAt,
    generatedAt,
    entryCount: entries.length,
    entries,
  } as const;
}

function fingerprint(payload: ReturnType<typeof canonicalPayload>): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

/**
 * Inventories irreversible athlete privacy mutations that happened after the selected backup.
 *
 * DB_COMMITTED is deliberately included because athlete data has already been irreversibly
 * transformed at that point even if external artifact purge/final completion is still pending.
 * The ledger is read-only and contains technical subject identifiers only; it does not copy names,
 * measurements, reasons or other free text.
 */
export async function buildRestorePrivacyReconciliationLedger(
  db: Database,
  backupCreatedAt: string,
  generatedAt = new Date().toISOString(),
): Promise<Readonly<RestorePrivacyReconciliationLedger>> {
  assertIsoTimestamp(backupCreatedAt, 'Backup creation time');
  assertIsoTimestamp(generatedAt, 'Ledger generation time');
  if (generatedAt < backupCreatedAt) {
    throw new Error('Ledger generation time cannot precede backup creation time');
  }

  const rows = await db.select({
    tenantId: athleteAnonymizationExecutions.tenantId,
    athleteId: athleteAnonymizationExecutions.athleteId,
    executionId: athleteAnonymizationExecutions.id,
    dbCommittedAt: athleteAnonymizationExecutions.dbCommittedAt,
    executionStatus: athleteAnonymizationExecutions.status,
  }).from(athleteAnonymizationExecutions).where(and(
    inArray(athleteAnonymizationExecutions.status, ['DB_COMMITTED', 'COMPLETED']),
    gt(athleteAnonymizationExecutions.dbCommittedAt, backupCreatedAt),
    lte(athleteAnonymizationExecutions.dbCommittedAt, generatedAt),
  )).orderBy(
    asc(athleteAnonymizationExecutions.dbCommittedAt),
    asc(athleteAnonymizationExecutions.tenantId),
    asc(athleteAnonymizationExecutions.athleteId),
    asc(athleteAnonymizationExecutions.id),
  );

  const entries = Object.freeze(rows.map((row) => {
    if (!row.dbCommittedAt || (row.executionStatus !== 'DB_COMMITTED' && row.executionStatus !== 'COMPLETED')) {
      throw new Error('Restore privacy ledger query returned an invalid irreversible execution');
    }
    assertIsoTimestamp(row.dbCommittedAt, 'Anonymization DB commit time');
    return Object.freeze({
      tenantId: row.tenantId,
      athleteId: row.athleteId,
      executionId: row.executionId,
      dbCommittedAt: row.dbCommittedAt,
      executionStatus: row.executionStatus,
    });
  }));
  const payload = canonicalPayload(backupCreatedAt, generatedAt, entries);
  return Object.freeze({ ...payload, fingerprint: fingerprint(payload) });
}
