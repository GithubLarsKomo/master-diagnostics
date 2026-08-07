import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  persistSignedRestorePrivacyEffectRecord,
  readVerifiedRestorePrivacyEffectRecord,
  restorePrivacyEffectFileName,
  type RestorePrivacyEffectIdentity,
  type RestorePrivacyEffectRecord,
} from '../src/services/restore-privacy-effect-journal';

const identity: RestorePrivacyEffectIdentity = Object.freeze({
  tenantId: 'tenant-a',
  athleteId: 'athlete-a',
  executionId: '123e4567-e89b-42d3-a456-426614174000',
  approvalId: 'approval-a',
  deletionRequestId: 'deletion-a',
  executionVersion: 1,
  policyVersion: '1.6.0',
  scopeFingerprint: `sha256:${'a'.repeat(64)}`,
  capabilityFingerprint: `sha256:${'b'.repeat(64)}`,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'masters-privacy-effect-'));
  const targetDir = join(root, 'journal');
  const keyFile = join(root, 'journal.key');
  await writeFile(keyFile, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 });
  return { root, targetDir, keyFile };
}

function pending(recordedAt = '2026-08-07T20:00:00.000Z'): RestorePrivacyEffectRecord {
  return Object.freeze({ journalVersion: 1, phase: 'PENDING', recordedAt, effect: identity });
}

function committed(
  recordedAt = '2026-08-07T20:00:02.000Z',
  dbCommittedAt = '2026-08-07T20:00:01.000Z',
): RestorePrivacyEffectRecord {
  return Object.freeze({ journalVersion: 1, phase: 'COMMITTED', recordedAt, dbCommittedAt, effect: identity });
}

function aborted(recordedAt = '2026-08-07T20:00:02.000Z'): RestorePrivacyEffectRecord {
  return Object.freeze({ journalVersion: 1, phase: 'ABORTED', recordedAt, effect: identity });
}

describe('restore privacy effect journal', () => {
  it('persists a pending intent and exactly one terminal outcome with private permissions', async () => {
    const { targetDir, keyFile } = await fixture();
    const pendingResult = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: pending() });
    const committedResult = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: committed() });

    expect(pendingResult.created).toBe(true);
    expect(committedResult.created).toBe(true);
    expect(pendingResult.path).toContain('-pending.json');
    expect(committedResult.path).toContain('-terminal.json');
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(pendingResult.path)).mode & 0o777).toBe(0o600);
    expect((await stat(committedResult.path)).mode & 0o777).toBe(0o600);

    const verifiedPending = await readVerifiedRestorePrivacyEffectRecord(pendingResult.path, keyFile);
    const verifiedCommitted = await readVerifiedRestorePrivacyEffectRecord(committedResult.path, keyFile);
    expect(verifiedPending.record.phase).toBe('PENDING');
    expect(verifiedCommitted.record.phase).toBe('COMMITTED');
    if (verifiedCommitted.record.phase === 'COMMITTED') {
      expect(verifiedCommitted.record.dbCommittedAt).toBe('2026-08-07T20:00:01.000Z');
    }
  });

  it('requires a verified matching pending marker before any terminal marker', async () => {
    const { targetDir, keyFile } = await fixture();
    await expect(persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: committed() }))
      .rejects.toThrow('Verified PENDING');

    await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: pending() });
    await expect(persistSignedRestorePrivacyEffectRecord({
      targetDir,
      keyFile,
      record: Object.freeze({
        ...aborted(),
        effect: Object.freeze({ ...identity, approvalId: 'approval-b' }),
      }),
    })).rejects.toThrow('does not match its PENDING intent');
  });

  it('accepts byte-identical retries and prevents contradictory terminal outcomes', async () => {
    const { targetDir, keyFile } = await fixture();
    const first = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: pending() });
    const retry = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: pending() });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);

    const terminal = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: committed() });
    const terminalRetry = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: committed() });
    expect(terminal.created).toBe(true);
    expect(terminalRetry.created).toBe(false);

    await expect(persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: aborted() }))
      .rejects.toThrow('already exists with different content');
  });

  it('rejects tampering and file-name/record mismatches', async () => {
    const { targetDir, keyFile } = await fixture();
    const result = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: pending() });
    const envelope = JSON.parse(await readFile(result.path, 'utf8')) as Record<string, unknown>;
    const record = envelope.record as Record<string, unknown>;
    record.recordedAt = '2026-08-07T20:00:04.000Z';
    await writeFile(result.path, `${JSON.stringify(envelope)}\n`);
    await expect(readVerifiedRestorePrivacyEffectRecord(result.path, keyFile))
      .rejects.toThrow('signature verification failed');

    const terminalName = restorePrivacyEffectFileName(committed());
    const renamedPath = join(targetDir, terminalName);
    await writeFile(renamedPath, await readFile(result.path));
    await expect(readVerifiedRestorePrivacyEffectRecord(renamedPath, keyFile))
      .rejects.toThrow('file name does not match');
  });

  it('validates canonical timestamps, fingerprints and commit ordering fail-closed', async () => {
    const { targetDir, keyFile } = await fixture();
    await expect(persistSignedRestorePrivacyEffectRecord({
      targetDir,
      keyFile,
      record: committed('2026-08-07T20:00:00.000Z', '2026-08-07T20:00:01.000Z'),
    })).rejects.toThrow('commit time must not follow');

    await expect(persistSignedRestorePrivacyEffectRecord({
      targetDir,
      keyFile,
      record: Object.freeze({
        journalVersion: 1,
        phase: 'PENDING',
        recordedAt: '2026-08-07 20:00:00Z',
        effect: identity,
      }),
    })).rejects.toThrow('canonical UTC');

    await expect(persistSignedRestorePrivacyEffectRecord({
      targetDir,
      keyFile,
      record: Object.freeze({
        journalVersion: 1,
        phase: 'PENDING',
        recordedAt: '2026-08-07T20:00:00.000Z',
        effect: Object.freeze({ ...identity, scopeFingerprint: 'bad' }),
      }),
    })).rejects.toThrow('fingerprints are invalid');
  });

  it('stores only technical reconciliation identifiers and fingerprints', async () => {
    const { targetDir, keyFile } = await fixture();
    await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: pending() });
    const result = await persistSignedRestorePrivacyEffectRecord({ targetDir, keyFile, record: committed() });
    const serialized = await readFile(result.path, 'utf8');
    for (const forbidden of ['firstName', 'lastName', 'birthDate', 'email', 'reason', 'measurement']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain(identity.executionId);
    expect(serialized).toContain(identity.scopeFingerprint);
  });
});
