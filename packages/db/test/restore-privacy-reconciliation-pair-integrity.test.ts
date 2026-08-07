import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RestorePrivacyReconciliationLedger } from '../src/services/restore-privacy-ledger';
import type { SignedRestorePrivacyLedgerEnvelope } from '../src/services/restore-privacy-ledger-storage';
import type { RestorePrivacyEffectIdentity } from '../src/services/restore-privacy-effect-journal';
import { buildRestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const cutoff = '2026-08-01T00:00:00.000Z';
const generatedAt = '2026-08-01T02:00:00.000Z';

function emptyLedgerEnvelope(): Readonly<SignedRestorePrivacyLedgerEnvelope> {
  const entries: readonly [] = Object.freeze([]);
  const canonical = JSON.stringify({ ledgerVersion: 1, sinceExclusive: cutoff, entries });
  const ledger: RestorePrivacyReconciliationLedger = Object.freeze({
    ledgerVersion: 1,
    sinceExclusive: cutoff,
    generatedAt,
    entriesFingerprint: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    entries,
  });
  return Object.freeze({
    envelopeVersion: 1,
    ledger,
    signature: `hmac-sha256:${'0'.repeat(64)}`,
  });
}

function identity(athleteId: string): Readonly<RestorePrivacyEffectIdentity> {
  return Object.freeze({
    tenantId: 'tenant-a',
    athleteId,
    executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    approvalId: 'approval-a',
    deletionRequestId: 'deletion-a',
    executionVersion: 1,
    policyVersion: '1.6.0',
    scopeFingerprint: `sha256:${'a'.repeat(64)}`,
    capabilityFingerprint: `sha256:${'b'.repeat(64)}`,
  });
}

describe('restore privacy reconciliation journal pair integrity', () => {
  it('rejects a terminal marker whose signed identity differs from PENDING', () => {
    expect(() => buildRestorePrivacyReconciliationReport(cutoff, emptyLedgerEnvelope(), [
      Object.freeze({
        journalVersion: 1,
        phase: 'PENDING' as const,
        recordedAt: '2026-08-01T00:30:00.000Z',
        effect: identity('athlete-a'),
      }),
      Object.freeze({
        journalVersion: 1,
        phase: 'COMMITTED' as const,
        recordedAt: '2026-08-01T01:00:00.000Z',
        dbCommittedAt: '2026-08-01T01:00:00.000Z',
        effect: identity('athlete-b'),
      }),
    ])).toThrow(/does not match its PENDING identity/);
  });

  it('rejects a terminal marker that predates its PENDING intent', () => {
    const effect = identity('athlete-a');
    expect(() => buildRestorePrivacyReconciliationReport(cutoff, emptyLedgerEnvelope(), [
      Object.freeze({
        journalVersion: 1,
        phase: 'PENDING' as const,
        recordedAt: '2026-08-01T01:30:00.000Z',
        effect,
      }),
      Object.freeze({
        journalVersion: 1,
        phase: 'ABORTED' as const,
        recordedAt: '2026-08-01T01:00:00.000Z',
        effect,
      }),
    ])).toThrow(/precedes its PENDING intent/);
  });
});
