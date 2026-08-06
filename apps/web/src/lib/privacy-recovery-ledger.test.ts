import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSystemPrivacyRecoveryLedger,
  type PrivacyRecoveryLedgerIdentity,
} from './privacy-recovery-ledger';

const roots: string[] = [];
const identity: PrivacyRecoveryLedgerIdentity = {
  tenantId: 'tenant-a',
  athleteId: 'athlete-a',
  executionId: 'execution-a',
  approvalId: 'approval-a',
};

async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'masters-privacy-recovery-ledger-'));
  roots.push(root);
  return { root, ledger: new FileSystemPrivacyRecoveryLedger(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('privacy recovery ledger', () => {
  it('records an intent and committed receipt append-only and idempotently', async () => {
    const { root, ledger: recovery } = await ledger();
    const intent = await recovery.recordIntent(identity, '2026-08-06T05:00:00.000Z');
    const committed = await recovery.recordCommitted(identity, '2026-08-06T05:01:00.000Z');
    const retried = await recovery.recordCommitted(identity, '2026-08-06T05:02:00.000Z');

    expect(intent).toMatchObject({ ledgerVersion: 1, state: 'INTENT', ...identity });
    expect(committed).toMatchObject({ ledgerVersion: 1, state: 'COMMITTED', ...identity });
    expect(retried).toEqual(committed);
    expect(retried.recordedAt).toBe('2026-08-06T05:01:00.000Z');

    const files = await readdir(root);
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.endsWith('.intent.json'))).toBe(true);
    expect(files.some((name) => name.endsWith('.committed.json'))).toBe(true);
    for (const name of files) {
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
    }
  });

  it('requires an intent before a terminal receipt', async () => {
    const { ledger: recovery } = await ledger();
    await expect(recovery.recordCommitted(identity, '2026-08-06T05:01:00.000Z'))
      .rejects.toThrow('requires a matching intent');
    await expect(recovery.recordAborted(identity, '2026-08-06T05:01:00.000Z'))
      .rejects.toThrow('requires a matching intent');
  });

  it('makes committed and aborted terminal outcomes mutually exclusive', async () => {
    const { ledger: committedLedger } = await ledger();
    await committedLedger.recordIntent(identity, '2026-08-06T05:00:00.000Z');
    await committedLedger.recordCommitted(identity, '2026-08-06T05:01:00.000Z');
    await expect(committedLedger.recordAborted(identity, '2026-08-06T05:02:00.000Z'))
      .rejects.toThrow('already committed');

    const { ledger: abortedLedger } = await ledger();
    await abortedLedger.recordIntent(identity, '2026-08-06T05:00:00.000Z');
    await abortedLedger.recordAborted(identity, '2026-08-06T05:01:00.000Z');
    await expect(abortedLedger.recordCommitted(identity, '2026-08-06T05:02:00.000Z'))
      .rejects.toThrow('already aborted');
  });
});
