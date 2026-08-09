import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRestorePrivatePromotionSwitchIntentRecord,
  ensureSignedRestorePrivatePromotionSwitchIntent,
  readVerifiedRestorePrivatePromotionSwitchIntent,
  RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME,
  type RestorePrivatePromotionCandidateSetHealthcheck,
} from '../src/services/restore-private-promotion-switch-intent';

const authorizedAt = '2026-08-08T20:55:00.000Z';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('unsupported canonical JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function healthyCandidateSet(
  reportCandidateName = 'master-diagnostics-restore-0123456789abcdefabcd-reports',
): Readonly<RestorePrivatePromotionCandidateSetHealthcheck> {
  const candidates = Object.freeze([
    Object.freeze({
      role: 'LIBSQL' as const,
      sourceSubpath: 'libsql' as const,
      candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-libsql',
      rollbackVolumeName: 'infra_libsql-data',
      sourceFingerprint: `sha256:${'1'.repeat(64)}` as const,
      candidateFingerprint: `sha256:${'1'.repeat(64)}` as const,
      fileCount: 3,
      directoryCount: 2,
      byteCount: 4096,
    }),
    Object.freeze({
      role: 'REPORTS' as const,
      sourceSubpath: 'reports' as const,
      candidateVolumeName: reportCandidateName,
      rollbackVolumeName: 'infra_report-data',
      sourceFingerprint: `sha256:${'2'.repeat(64)}` as const,
      candidateFingerprint: `sha256:${'2'.repeat(64)}` as const,
      fileCount: 4,
      directoryCount: 3,
      byteCount: 8192,
    }),
    Object.freeze({
      role: 'TENANT_EXPORTS' as const,
      sourceSubpath: 'tenant-exports' as const,
      candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-tenant-exports',
      rollbackVolumeName: 'infra_export-data',
      sourceFingerprint: `sha256:${'3'.repeat(64)}` as const,
      candidateFingerprint: `sha256:${'3'.repeat(64)}` as const,
      fileCount: 0,
      directoryCount: 1,
      byteCount: 0,
    }),
    Object.freeze({
      role: 'DATA_SUBJECT_DELIVERY' as const,
      sourceSubpath: 'data-subject-delivery' as const,
      candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-data-subject-delivery',
      rollbackVolumeName: 'infra_data-subject-delivery-data',
      sourceFingerprint: `sha256:${'4'.repeat(64)}` as const,
      candidateFingerprint: `sha256:${'4'.repeat(64)}` as const,
      fileCount: 1,
      directoryCount: 1,
      byteCount: 128,
    }),
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
    planFingerprint: body.planFingerprint,
    activeVolumeSetFingerprint: body.activeVolumeSetFingerprint,
    candidateSetId: body.candidateSetId,
    candidateSetFingerprint: sha256(canonicalJson(body)),
    candidates,
  });
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-promotion-switch-intent-'));
  const targetDir = join(workspace, 'promotion');
  const keyFile = join(workspace, 'promotion.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 71).toString('base64')}\n`, { mode: 0o600 });
  return { workspace, targetDir, keyFile };
}

describe('restore private promotion switch intent', () => {
  it('binds the healthy candidate set to an explicit crash-safe switch contract', () => {
    const healthcheck = healthyCandidateSet();
    const record = createRestorePrivatePromotionSwitchIntentRecord(healthcheck, authorizedAt);
    expect(record).toMatchObject({
      switchIntentVersion: 1,
      phase: 'PENDING',
      authorizedAt,
      candidateHealthcheckVersion: 1,
      candidateSetFingerprint: healthcheck.candidateSetFingerprint,
      planFingerprint: healthcheck.planFingerprint,
      activeVolumeSetFingerprint: healthcheck.activeVolumeSetFingerprint,
      candidateSetId: healthcheck.candidateSetId,
      selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1',
      rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES',
      caddyPolicy: 'PRESERVE_CURRENT',
      crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION',
      rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER',
      completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK',
      preSwitchHealthcheckRequired: true,
      rollbackVolumesMustRemain: true,
      productionSwitchAuthorized: true,
      promotionExecuted: false,
    });
    expect(record.volumes.map((item) => item.role)).toEqual([
      'LIBSQL',
      'REPORTS',
      'TENANT_EXPORTS',
      'DATA_SUBJECT_DELIVERY',
    ]);
    expect(record.volumes.every((item) => item.candidateVolumeName !== item.rollbackVolumeName)).toBe(true);
  });

  it('persists a signed immutable intent and reuses its original authorization time', async () => {
    const { targetDir, keyFile } = await fixture();
    const healthcheck = healthyCandidateSet();
    const first = await ensureSignedRestorePrivatePromotionSwitchIntent({
      targetDir,
      keyFile,
      healthcheck,
      authorizedAt,
    });
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME));
    expect(first.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    const second = await ensureSignedRestorePrivatePromotionSwitchIntent({
      targetDir,
      keyFile,
      healthcheck,
      authorizedAt: '2026-08-08T21:05:00.000Z',
    });
    expect(second.created).toBe(false);
    expect(second.envelope).toEqual(first.envelope);
    expect(second.envelope.record.authorizedAt).toBe(authorizedAt);
    expect(await readVerifiedRestorePrivatePromotionSwitchIntent(
      first.path,
      keyFile,
      healthcheck,
    )).toEqual(first.envelope);
  });

  it('refuses to reuse an intent when the freshly checked candidate set changes', async () => {
    const { targetDir, keyFile } = await fixture();
    const original = healthyCandidateSet();
    const created = await ensureSignedRestorePrivatePromotionSwitchIntent({
      targetDir,
      keyFile,
      healthcheck: original,
      authorizedAt,
    });
    const changed = healthyCandidateSet('master-diagnostics-restore-fedcba9876543210abcd-reports');

    await expect(readVerifiedRestorePrivatePromotionSwitchIntent(
      created.path,
      keyFile,
      changed,
    )).rejects.toThrow('does not match candidate-set healthcheck evidence');
    await expect(ensureSignedRestorePrivatePromotionSwitchIntent({
      targetDir,
      keyFile,
      healthcheck: changed,
      authorizedAt: '2026-08-08T21:10:00.000Z',
    })).rejects.toThrow();
  });

  it('rejects stale, malformed or self-inconsistent candidate-set reports', () => {
    const healthy = healthyCandidateSet();
    expect(() => createRestorePrivatePromotionSwitchIntentRecord({
      ...healthy,
      status: 'BLOCKED',
    } as unknown as RestorePrivatePromotionCandidateSetHealthcheck, authorizedAt)).toThrow(
      'requires a fresh healthy candidate-set report',
    );
    expect(() => createRestorePrivatePromotionSwitchIntentRecord({
      ...healthy,
      candidateSetFingerprint: `sha256:${'f'.repeat(64)}`,
    }, authorizedAt)).toThrow('fingerprint does not match');
    expect(() => createRestorePrivatePromotionSwitchIntentRecord({
      ...healthy,
      candidates: healthy.candidates.map((item, index) => index === 0
        ? { ...item, candidateFingerprint: `sha256:${'9'.repeat(64)}` as const }
        : item),
    }, authorizedAt)).toThrow('tree fingerprint does not match');
  });

  it('detects safety-policy tampering before any future switch executor can consume it', async () => {
    const { targetDir, keyFile } = await fixture();
    const healthcheck = healthyCandidateSet();
    const created = await ensureSignedRestorePrivatePromotionSwitchIntent({
      targetDir,
      keyFile,
      healthcheck,
      authorizedAt,
    });
    const parsed = JSON.parse(await readFile(created.path, 'utf8')) as {
      record: { crashRecoveryPolicy: string };
      signature: string;
    };
    parsed.record.crashRecoveryPolicy = 'BEST_EFFORT';
    await writeFile(created.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionSwitchIntent(
      created.path,
      keyFile,
      healthcheck,
    )).rejects.toThrow('safety policy is invalid');
  });
});
