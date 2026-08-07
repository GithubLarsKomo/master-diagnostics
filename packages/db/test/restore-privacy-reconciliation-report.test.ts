import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RestorePrivacyLedgerEntry,
  RestorePrivacyReconciliationLedger,
} from '../src/services/restore-privacy-ledger';
import { persistSignedRestorePrivacyLedger } from '../src/services/restore-privacy-ledger-storage';
import {
  persistSignedRestorePrivacyEffectRecord,
  type RestorePrivacyEffectIdentity,
} from '../src/services/restore-privacy-effect-journal';
import { createRestorePrivacyReconciliationReportFromStorage } from '../src/services/restore-privacy-reconciliation-report';

const roots: string[] = [];
const cutoff = '2026-08-01T00:00:00.000Z';

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fingerprint(entries: readonly Readonly<RestorePrivacyLedgerEntry>[]): `sha256:${string}` {
  const canonical = JSON.stringify({ ledgerVersion: 1, sinceExclusive: cutoff, entries });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function effect(executionId: string, suffix: string): Readonly<RestorePrivacyEffectIdentity> {
  return Object.freeze({
    tenantId: 'tenant-a',
    athleteId: `athlete-${suffix}`,
    executionId,
    approvalId: `approval-${suffix}`,
    deletionRequestId: `deletion-${suffix}`,
    executionVersion: 1,
    policyVersion: '1.6.0',
    scopeFingerprint: `sha256:${'a'.repeat(63)}${suffix}`,
    capabilityFingerprint: `sha256:${'b'.repeat(63)}${suffix}`,
  });
}

function ledgerEntry(
  identity: Readonly<RestorePrivacyEffectIdentity>,
  dbCommittedAt: string,
): Readonly<RestorePrivacyLedgerEntry> {
  return Object.freeze({ ...identity, dbCommittedAt });
}

async function setupStorage(entries: readonly Readonly<RestorePrivacyLedgerEntry>[], generatedAt: string) {
  const root = await tempRoot('masters-restore-reconcile-');
  const ledgerDir = join(root, 'ledger');
  const journalDir = join(root, 'journal');
  const ledgerKeyFile = join(root, 'ledger.key');
  const journalKeyFile = join(root, 'journal.key');
  await mkdir(ledgerDir, { recursive: true });
  await mkdir(journalDir, { recursive: true });
  await writeFile(ledgerKeyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  await writeFile(journalKeyFile, `${Buffer.alloc(32, 9).toString('base64')}\n`, { mode: 0o600 });
  const ledger: RestorePrivacyReconciliationLedger = Object.freeze({
    ledgerVersion: 1,
    sinceExclusive: cutoff,
    generatedAt,
    entriesFingerprint: fingerprint(entries),
    entries: Object.freeze([...entries]),
  });
  await persistSignedRestorePrivacyLedger({ ledger, targetDir: ledgerDir, keyFile: ledgerKeyFile });
  return { ledgerDir, journalDir, ledgerKeyFile, journalKeyFile };
}

async function pending(
  storage: Awaited<ReturnType<typeof setupStorage>>,
  identity: Readonly<RestorePrivacyEffectIdentity>,
  recordedAt: string,
) {
  await persistSignedRestorePrivacyEffectRecord({
    targetDir: storage.journalDir,
    keyFile: storage.journalKeyFile,
    record: Object.freeze({ journalVersion: 1, phase: 'PENDING', recordedAt, effect: identity }),
  });
}

async function committed(
  storage: Awaited<ReturnType<typeof setupStorage>>,
  identity: Readonly<RestorePrivacyEffectIdentity>,
  dbCommittedAt: string,
) {
  await persistSignedRestorePrivacyEffectRecord({
    targetDir: storage.journalDir,
    keyFile: storage.journalKeyFile,
    record: Object.freeze({
      journalVersion: 1,
      phase: 'COMMITTED',
      recordedAt: dbCommittedAt,
      dbCommittedAt,
      effect: identity,
    }),
  });
}

async function aborted(
  storage: Awaited<ReturnType<typeof setupStorage>>,
  identity: Readonly<RestorePrivacyEffectIdentity>,
  recordedAt: string,
) {
  await persistSignedRestorePrivacyEffectRecord({
    targetDir: storage.journalDir,
    keyFile: storage.journalKeyFile,
    record: Object.freeze({ journalVersion: 1, phase: 'ABORTED', recordedAt, effect: identity }),
  });
}

function report(storage: Awaited<ReturnType<typeof setupStorage>>) {
  return createRestorePrivacyReconciliationReportFromStorage({
    backupCutoff: cutoff,
    ...storage,
  });
}

describe('restore privacy reconciliation report', () => {
  it('is CLEAR for a trusted empty ledger and an empty journal but never authorizes promotion', async () => {
    const storage = await setupStorage([], '2026-08-01T02:00:00.000Z');
    const result = await report(storage);
    expect(result).toMatchObject({
      reportVersion: 1,
      backupCutoff: cutoff,
      status: 'CLEAR',
      reconciliationReady: true,
      promotionAllowed: false,
      journalMarkerCount: 0,
      obligations: [],
      blockers: [],
    });
    expect(result.ledger?.entryCount).toBe(0);
  });

  it('merges matching ledger/journal evidence and accepts a later journal-only commit as replay obligation', async () => {
    const first = effect('11111111-1111-4111-8111-111111111111', '1');
    const second = effect('22222222-2222-4222-8222-222222222222', '2');
    const firstCommit = '2026-08-01T01:00:00.000Z';
    const secondCommit = '2026-08-01T03:00:00.000Z';
    const storage = await setupStorage([ledgerEntry(first, firstCommit)], '2026-08-01T02:00:00.000Z');
    await pending(storage, first, '2026-08-01T00:59:00.000Z');
    await committed(storage, first, firstCommit);
    await pending(storage, second, '2026-08-01T02:59:00.000Z');
    await committed(storage, second, secondCommit);

    const result = await report(storage);
    expect(result.status).toBe('REPLAY_REQUIRED');
    expect(result.blockers).toEqual([]);
    expect(result.obligations).toHaveLength(2);
    expect(result.obligations[0]).toMatchObject({
      executionId: first.executionId,
      dbCommittedAt: firstCommit,
      sources: ['JOURNAL', 'LEDGER'],
    });
    expect(result.obligations[1]).toMatchObject({
      executionId: second.executionId,
      dbCommittedAt: secondCommit,
      sources: ['JOURNAL'],
    });
  });

  it('blocks an unresolved PENDING intent even when the trusted ledger is otherwise clear', async () => {
    const identity = effect('33333333-3333-4333-8333-333333333333', '3');
    const storage = await setupStorage([], '2026-08-01T02:00:00.000Z');
    await pending(storage, identity, '2026-08-01T01:30:00.000Z');

    const result = await report(storage);
    expect(result.status).toBe('BLOCKED');
    expect(result.reconciliationReady).toBe(false);
    expect(result.blockers).toContainEqual({ code: 'OPEN_PENDING_INTENT', executionId: identity.executionId });
  });

  it('blocks a journal commit inside the ledger observation window when the ledger omitted it', async () => {
    const identity = effect('44444444-4444-4444-8444-444444444444', '4');
    const storage = await setupStorage([], '2026-08-01T02:00:00.000Z');
    await pending(storage, identity, '2026-08-01T00:59:00.000Z');
    await committed(storage, identity, '2026-08-01T01:00:00.000Z');

    const result = await report(storage);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers).toContainEqual({
      code: 'JOURNAL_COMMIT_MISSING_FROM_LEDGER',
      executionId: identity.executionId,
    });
  });

  it('blocks a trusted ledger entry that the journal marks ABORTED', async () => {
    const identity = effect('55555555-5555-4555-8555-555555555555', '5');
    const dbCommittedAt = '2026-08-01T01:00:00.000Z';
    const storage = await setupStorage([ledgerEntry(identity, dbCommittedAt)], '2026-08-01T02:00:00.000Z');
    await pending(storage, identity, '2026-08-01T00:58:00.000Z');
    await aborted(storage, identity, '2026-08-01T01:01:00.000Z');

    const result = await report(storage);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers).toContainEqual({
      code: 'LEDGER_ABORT_CONTRADICTION',
      executionId: identity.executionId,
    });
  });
});
