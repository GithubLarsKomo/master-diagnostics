import { createHash } from 'node:crypto';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackupManifest } from '../src/services/backup-bundle';
import {
  createRestoreSourceProvenanceRecord,
  persistSignedRestoreSourceProvenance,
} from '../src/services/backup-restore-source-provenance';
import {
  ensureSignedRestorePrivatePromotionSourceProvenanceBinding,
  readVerifiedRestorePrivatePromotionSourceProvenanceBinding,
} from '../src/services/restore-private-promotion-source-provenance-binding';
import {
  ensureSignedRestorePrivatePromotionSwitchIntent,
  type RestorePrivatePromotionCandidateSetHealthcheck,
} from '../src/services/restore-private-promotion-switch-intent';

const stagingName = 'restore-20260811T060000000Z-01234567-89ab-cdef-0123-456789abcdef';
const backupFileName = 'masters-backup-20260811T060000000Z-01234567-89ab-cdef-0123-456789abcdef.mdbak';
const authorizedAt = '2026-08-11T06:30:00.000Z';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('unsupported canonical value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifest(): Readonly<BackupManifest> {
  return Object.freeze({
    bundleVersion: 1 as const,
    createdAt: '2026-08-11T06:00:00.000Z',
    consistency: 'CLEANLY_STOPPED_VOLUMES' as const,
    encryption: 'AES-256-GCM' as const,
    restoreReconciliationRequired: true as const,
    sources: Object.freeze([
      'libsql' as const,
      'reports' as const,
      'tenant-exports' as const,
      'data-subject-delivery' as const,
      'caddy-data' as const,
      'caddy-config' as const,
    ]),
  });
}

function healthyCandidateSet(
  candidateSetId = 'restore-0123456789abcdefabcd',
): Readonly<RestorePrivatePromotionCandidateSetHealthcheck> {
  const candidates = Object.freeze([
    Object.freeze({ role: 'LIBSQL' as const, sourceSubpath: 'libsql' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-libsql`, rollbackVolumeName: 'infra_libsql-data', sourceFingerprint: `sha256:${'1'.repeat(64)}` as const, candidateFingerprint: `sha256:${'1'.repeat(64)}` as const, fileCount: 2, directoryCount: 1, byteCount: 4096 }),
    Object.freeze({ role: 'REPORTS' as const, sourceSubpath: 'reports' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-reports`, rollbackVolumeName: 'infra_report-data', sourceFingerprint: `sha256:${'2'.repeat(64)}` as const, candidateFingerprint: `sha256:${'2'.repeat(64)}` as const, fileCount: 3, directoryCount: 2, byteCount: 8192 }),
    Object.freeze({ role: 'TENANT_EXPORTS' as const, sourceSubpath: 'tenant-exports' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-tenant-exports`, rollbackVolumeName: 'infra_export-data', sourceFingerprint: `sha256:${'3'.repeat(64)}` as const, candidateFingerprint: `sha256:${'3'.repeat(64)}` as const, fileCount: 0, directoryCount: 1, byteCount: 0 }),
    Object.freeze({ role: 'DATA_SUBJECT_DELIVERY' as const, sourceSubpath: 'data-subject-delivery' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-data-subject-delivery`, rollbackVolumeName: 'infra_data-subject-delivery-data', sourceFingerprint: `sha256:${'4'.repeat(64)}` as const, candidateFingerprint: `sha256:${'4'.repeat(64)}` as const, fileCount: 1, directoryCount: 1, byteCount: 128 }),
  ]);
  const body = Object.freeze({
    healthcheckVersion: 1,
    planFingerprint: `sha256:${'a'.repeat(64)}` as const,
    activeVolumeSetFingerprint: `sha256:${'b'.repeat(64)}` as const,
    candidateSetId,
    candidates,
  });
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
    candidateSetId,
    candidateSetFingerprint: sha256(canonicalJson(body)),
    candidates,
  });
}

async function fixture(candidateSetId = 'restore-0123456789abcdefabcd') {
  const root = await mkdtemp(join(tmpdir(), 'restore-source-binding-'));
  const stagingDir = join(root, stagingName);
  const switchDir = join(root, 'switch');
  const evidenceDir = join(root, 'evidence');
  const backupKeyFile = join(root, 'backup.key');
  const promotionKeyFile = join(root, 'promotion.key');
  const wrongBackupKeyFile = join(root, 'wrong-backup.key');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(stagingDir, { mode: 0o700 });
  await writeFile(backupKeyFile, `${Buffer.alloc(32, 31).toString('base64')}\n`, { mode: 0o600 });
  await writeFile(promotionKeyFile, `${Buffer.alloc(32, 47).toString('base64')}\n`, { mode: 0o600 });
  await writeFile(wrongBackupKeyFile, `${Buffer.alloc(32, 59).toString('base64')}\n`, { mode: 0o600 });

  const provenanceRecord = createRestoreSourceProvenanceRecord({
    stagingName,
    backupFileName,
    backupSha256: 'e'.repeat(64),
    manifest: manifest(),
  });
  const provenance = await persistSignedRestoreSourceProvenance({
    stagingPath: stagingDir,
    keyFile: backupKeyFile,
    record: provenanceRecord,
  });
  const switchIntent = await ensureSignedRestorePrivatePromotionSwitchIntent({
    targetDir: switchDir,
    keyFile: promotionKeyFile,
    healthcheck: healthyCandidateSet(candidateSetId),
    authorizedAt,
  });
  return { root, stagingDir, switchDir, evidenceDir, backupKeyFile, promotionKeyFile, wrongBackupKeyFile, provenance, switchIntent };
}

describe('restore private promotion source provenance binding', () => {
  it('binds exact encrypted backup provenance to the authenticated switch intent', async () => {
    const fx = await fixture();
    const first = await ensureSignedRestorePrivatePromotionSourceProvenanceBinding({
      targetDir: fx.evidenceDir,
      promotionKeyFile: fx.promotionKeyFile,
      backupKeyFile: fx.backupKeyFile,
      sourceProvenanceFile: fx.provenance.path,
      switchIntentFile: fx.switchIntent.path,
    });
    expect(first.created).toBe(true);
    expect(first.envelope.record).toMatchObject({
      stagingName,
      backupFileName,
      backupSha256: `sha256:${'e'.repeat(64)}`,
      backupCreatedAt: manifest().createdAt,
      sourceProvenanceSignature: fx.provenance.envelope.signature,
      switchIntentSignature: fx.switchIntent.envelope.signature,
      planFingerprint: fx.switchIntent.envelope.record.planFingerprint,
      candidateSetId: fx.switchIntent.envelope.record.candidateSetId,
      candidateSetFingerprint: fx.switchIntent.envelope.record.candidateSetFingerprint,
      productionMutationAllowed: false,
      promotionExecuted: false,
    });
    expect(first.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(first.envelope.record.bindingFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    const second = await ensureSignedRestorePrivatePromotionSourceProvenanceBinding({
      targetDir: fx.evidenceDir,
      promotionKeyFile: fx.promotionKeyFile,
      backupKeyFile: fx.backupKeyFile,
      sourceProvenanceFile: fx.provenance.path,
      switchIntentFile: fx.switchIntent.path,
    });
    expect(second.created).toBe(false);
    expect(second.envelope).toEqual(first.envelope);
    expect(await readVerifiedRestorePrivatePromotionSourceProvenanceBinding(first.path, fx.promotionKeyFile, fx.switchIntent.envelope)).toEqual(first.envelope);
  });

  it('rejects the provenance under a different backup key', async () => {
    const fx = await fixture();
    await expect(ensureSignedRestorePrivatePromotionSourceProvenanceBinding({
      targetDir: fx.evidenceDir,
      promotionKeyFile: fx.promotionKeyFile,
      backupKeyFile: fx.wrongBackupKeyFile,
      sourceProvenanceFile: fx.provenance.path,
      switchIntentFile: fx.switchIntent.path,
    })).rejects.toThrow('signature verification failed');
  });

  it('refuses to reuse durable provenance evidence for another valid candidate set', async () => {
    const fx = await fixture();
    await ensureSignedRestorePrivatePromotionSourceProvenanceBinding({
      targetDir: fx.evidenceDir,
      promotionKeyFile: fx.promotionKeyFile,
      backupKeyFile: fx.backupKeyFile,
      sourceProvenanceFile: fx.provenance.path,
      switchIntentFile: fx.switchIntent.path,
    });

    const other = await fixture('restore-fedcba9876543210abcd');
    await expect(ensureSignedRestorePrivatePromotionSourceProvenanceBinding({
      targetDir: fx.evidenceDir,
      promotionKeyFile: fx.promotionKeyFile,
      backupKeyFile: fx.backupKeyFile,
      sourceProvenanceFile: fx.provenance.path,
      switchIntentFile: other.switchIntent.path,
    })).rejects.toThrow();
  });
});
