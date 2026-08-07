import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RestorePrivacyReconciliationLedger } from '../src/services/restore-privacy-ledger';
import {
  persistSignedRestorePrivacyLedger,
  readVerifiedSignedRestorePrivacyLedger,
  restorePrivacyLedgerFileName,
} from '../src/services/restore-privacy-ledger-storage';

const ledger = Object.freeze({
  ledgerVersion: 1,
  sinceExclusive: '2026-08-01T00:00:00.000Z',
  generatedAt: '2026-08-06T12:00:00.000Z',
  entriesFingerprint: `sha256:${'a'.repeat(64)}`,
  entries: Object.freeze([
    Object.freeze({
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      executionId: 'execution-a',
      approvalId: 'approval-a',
      deletionRequestId: 'deletion-a',
      executionVersion: 1,
      policyVersion: '1.6.0',
      scopeFingerprint: `sha256:${'b'.repeat(64)}`,
      capabilityFingerprint: `sha256:${'c'.repeat(64)}`,
      dbCommittedAt: '2026-08-03T10:00:00.000Z',
    }),
  ]),
}) satisfies RestorePrivacyReconciliationLedger;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'masters-restore-privacy-ledger-'));
  const targetDir = join(root, 'ledger');
  const keyFile = join(root, 'ledger.key');
  await writeFile(keyFile, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 });
  return { root, targetDir, keyFile };
}

describe('signed restore privacy ledger storage', () => {
  it('persists a signed snapshot with restrictive permissions and verifies it', async () => {
    const { targetDir, keyFile } = await fixture();
    const persisted = await persistSignedRestorePrivacyLedger({ ledger, targetDir, keyFile });

    expect(persisted.created).toBe(true);
    expect(persisted.path).toBe(join(targetDir, restorePrivacyLedgerFileName(ledger)));
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(persisted.path)).mode & 0o777).toBe(0o600);
    expect(persisted.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    const verified = await readVerifiedSignedRestorePrivacyLedger(persisted.path, keyFile);
    expect(verified.ledger).toEqual(ledger);
    expect(verified.signature).toBe(persisted.envelope.signature);
    expect(JSON.stringify(verified)).not.toContain(Buffer.alloc(32, 7).toString('base64'));
  });

  it('is idempotent for the same signed snapshot and never overwrites different content', async () => {
    const { targetDir, keyFile } = await fixture();
    const first = await persistSignedRestorePrivacyLedger({ ledger, targetDir, keyFile });
    const retry = await persistSignedRestorePrivacyLedger({ ledger, targetDir, keyFile });
    expect(retry.created).toBe(false);
    expect(retry.path).toBe(first.path);

    const different = Object.freeze({ ...ledger, generatedAt: '2026-08-06T13:00:00.000Z' });
    await expect(persistSignedRestorePrivacyLedger({ ledger: different, targetDir, keyFile }))
      .rejects.toThrow('already exists with different content');
    expect(await readFile(first.path, 'utf8')).toContain('2026-08-06T12:00:00.000Z');
  });

  it('fails closed when the signed ledger or signing key is tampered with', async () => {
    const { root, targetDir, keyFile } = await fixture();
    const persisted = await persistSignedRestorePrivacyLedger({ ledger, targetDir, keyFile });
    const parsed = JSON.parse(await readFile(persisted.path, 'utf8')) as Record<string, unknown>;
    const tamperedLedger = parsed.ledger as Record<string, unknown>;
    tamperedLedger.generatedAt = '2026-08-06T13:00:00.000Z';
    await writeFile(persisted.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedSignedRestorePrivacyLedger(persisted.path, keyFile))
      .rejects.toThrow('signature verification failed');

    const wrongKey = join(root, 'wrong.key');
    await writeFile(wrongKey, Buffer.alloc(32, 8).toString('base64'));
    await expect(readVerifiedSignedRestorePrivacyLedger(persisted.path, wrongKey))
      .rejects.toThrow('signature verification failed');
  });

  it('rejects malformed key material and noncanonical ledger file names', async () => {
    const { root, targetDir, keyFile } = await fixture();
    await writeFile(keyFile, Buffer.alloc(31, 1).toString('base64'));
    await expect(persistSignedRestorePrivacyLedger({ ledger, targetDir, keyFile }))
      .rejects.toThrow('exactly 32 bytes');

    const arbitrary = join(root, 'ledger.json');
    await writeFile(arbitrary, '{}');
    await expect(readVerifiedSignedRestorePrivacyLedger(arbitrary, keyFile))
      .rejects.toThrow('file name is invalid');
  });
});
