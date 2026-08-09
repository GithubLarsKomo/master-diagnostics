import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAuthenticatedRestorePrivatePromotionSwitchIntent } from '../src/services/restore-private-promotion-switch-authentication';
import {
  ensureSignedRestorePrivatePromotionSwitchIntent,
  type RestorePrivatePromotionCandidateSetHealthcheck,
} from '../src/services/restore-private-promotion-switch-intent';
import {
  ensureSignedRestorePrivatePromotionSwitchJournal,
  readVerifiedRestorePrivatePromotionSwitchJournal,
} from '../src/services/restore-private-promotion-switch-journal';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('unsupported canonical JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function healthyCandidateSet(): Readonly<RestorePrivatePromotionCandidateSetHealthcheck> {
  const candidates = Object.freeze([
    Object.freeze({ role: 'LIBSQL' as const, sourceSubpath: 'libsql' as const, candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-libsql', rollbackVolumeName: 'infra_libsql-data', sourceFingerprint: `sha256:${'1'.repeat(64)}` as const, candidateFingerprint: `sha256:${'1'.repeat(64)}` as const, fileCount: 2, directoryCount: 2, byteCount: 2048 }),
    Object.freeze({ role: 'REPORTS' as const, sourceSubpath: 'reports' as const, candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-reports', rollbackVolumeName: 'infra_report-data', sourceFingerprint: `sha256:${'2'.repeat(64)}` as const, candidateFingerprint: `sha256:${'2'.repeat(64)}` as const, fileCount: 3, directoryCount: 2, byteCount: 4096 }),
    Object.freeze({ role: 'TENANT_EXPORTS' as const, sourceSubpath: 'tenant-exports' as const, candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-tenant-exports', rollbackVolumeName: 'infra_export-data', sourceFingerprint: `sha256:${'3'.repeat(64)}` as const, candidateFingerprint: `sha256:${'3'.repeat(64)}` as const, fileCount: 0, directoryCount: 1, byteCount: 0 }),
    Object.freeze({ role: 'DATA_SUBJECT_DELIVERY' as const, sourceSubpath: 'data-subject-delivery' as const, candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-data-subject-delivery', rollbackVolumeName: 'infra_data-subject-delivery-data', sourceFingerprint: `sha256:${'4'.repeat(64)}` as const, candidateFingerprint: `sha256:${'4'.repeat(64)}` as const, fileCount: 1, directoryCount: 1, byteCount: 256 }),
  ]);
  const body = {
    healthcheckVersion: 1,
    planFingerprint: `sha256:${'a'.repeat(64)}` as const,
    activeVolumeSetFingerprint: `sha256:${'b'.repeat(64)}` as const,
    candidateSetId: 'restore-0123456789abcdefabcd',
    candidates,
  };
  return Object.freeze({
    mode: 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK' as const,
    status: 'CANDIDATE_SET_HEALTHY' as const,
    healthcheckVersion: 1 as const,
    evidenceRecomputed: true as const,
    candidateMutationAllowed: false as const,
    productionMutationAllowed: false as const,
    promotionExecuted: false as const,
    ...body,
    candidateSetFingerprint: sha256(canonicalJson(body)),
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-switch-authentication-'));
  const keyFile = join(root, 'promotion.key');
  const switchDir = join(root, 'switch');
  const journalDir = join(root, 'journal');
  await writeFile(keyFile, `${Buffer.alloc(32, 109).toString('base64')}\n`, { mode: 0o600 });
  const healthcheck = healthyCandidateSet();
  const intent = await ensureSignedRestorePrivatePromotionSwitchIntent({
    targetDir: switchDir,
    keyFile,
    healthcheck,
    authorizedAt: '2026-08-09T10:00:00.000Z',
  });
  const journal = await ensureSignedRestorePrivatePromotionSwitchJournal({
    targetDir: journalDir,
    keyFile,
    switchIntent: intent.envelope,
    startedAt: '2026-08-09T10:01:00.000Z',
  });
  return { root, keyFile, healthcheck, intent, journal };
}

describe('restore private promotion post-cutover authentication', () => {
  it('authenticates the signed switch intent without requiring a fresh pre-cutover healthcheck', async () => {
    const { keyFile, intent } = await fixture();
    const authenticated = await readAuthenticatedRestorePrivatePromotionSwitchIntent(intent.path, keyFile);
    expect(authenticated).toEqual(intent.envelope);
    expect(authenticated.record.preSwitchHealthcheckRequired).toBe(true);
    expect(authenticated.record.promotionExecuted).toBe(false);
  });

  it('uses authenticated intent to verify the durable journal independently of current active volumes', async () => {
    const { keyFile, intent, journal } = await fixture();
    const authenticated = await readAuthenticatedRestorePrivatePromotionSwitchIntent(intent.path, keyFile);
    expect(await readVerifiedRestorePrivatePromotionSwitchJournal(journal.path, keyFile, authenticated)).toEqual(journal.envelope);
  });

  it('rejects HMAC tampering even when internal shape remains syntactically valid', async () => {
    const { keyFile, intent } = await fixture();
    const parsed = JSON.parse(await readFile(intent.path, 'utf8')) as {
      record: { candidateSetFingerprint: string };
      signature: string;
    };
    parsed.record.candidateSetFingerprint = `sha256:${'f'.repeat(64)}`;
    await writeFile(intent.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readAuthenticatedRestorePrivatePromotionSwitchIntent(intent.path, keyFile)).rejects.toThrow(
      'signature verification failed',
    );
  });

  it('rejects unsafe internal policy before accepting a signed envelope as recovery evidence', async () => {
    const { keyFile, intent } = await fixture();
    const parsed = JSON.parse(await readFile(intent.path, 'utf8')) as {
      record: { rollbackVolumesMustRemain: boolean };
      signature: string;
    };
    parsed.record.rollbackVolumesMustRemain = false;
    await writeFile(intent.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readAuthenticatedRestorePrivatePromotionSwitchIntent(intent.path, keyFile)).rejects.toThrow(
      'safety policy is invalid',
    );
  });
});
