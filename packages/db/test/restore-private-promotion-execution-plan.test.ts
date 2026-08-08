import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RestorePrivatePromotionExecutionPreflight } from '../src/services/restore-private-promotion-execution-preflight';
import {
  createRestorePrivatePromotionExecutionPlanRecord,
  ensureSignedRestorePrivatePromotionExecutionPlan,
  readVerifiedRestorePrivatePromotionExecutionPlan,
  RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME,
  type RestorePrivatePromotionActiveVolumeSet,
} from '../src/services/restore-private-promotion-execution-plan';

const preflight = Object.freeze({
  preflightVersion: 1,
  status: 'EXECUTION_READY',
  authorizationScope: 'PRIVATE_RESTORE_PROMOTION',
  evidenceRecomputed: true,
  backupCutoff: '2026-08-01T00:00:00.000Z',
  readinessEvidenceFingerprint: `sha256:${'a'.repeat(64)}`,
  healthcheckFingerprint: `sha256:${'b'.repeat(64)}`,
  intentSignature: `hmac-sha256:${'c'.repeat(64)}`,
  authorizedAt: '2026-08-08T12:00:00.000Z',
  promotionAllowed: true,
  authorizationPersisted: true,
  promotionExecuted: false,
  executionFingerprint: `sha256:${'d'.repeat(64)}`,
}) satisfies Readonly<RestorePrivatePromotionExecutionPreflight>;

const activeVolumes = Object.freeze({
  libsql: 'master-diagnostics_libsql-data',
  reports: 'master-diagnostics_report-data',
  tenantExports: 'master-diagnostics_export-data',
  dataSubjectDelivery: 'master-diagnostics_data-subject-delivery-data',
}) satisfies Readonly<RestorePrivatePromotionActiveVolumeSet>;

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-promotion-plan-'));
  const targetDir = join(workspace, 'promotion');
  const keyFile = join(workspace, 'promotion.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 61).toString('base64')}\n`, { mode: 0o600 });
  return { workspace, targetDir, keyFile };
}

describe('restore private promotion execution plan', () => {
  it('binds four deterministic candidate volumes while preserving the active set as rollback', () => {
    const record = createRestorePrivatePromotionExecutionPlanRecord(preflight, activeVolumes);
    expect(record).toMatchObject({
      planVersion: 1,
      phase: 'PREPARED',
      backupCutoff: preflight.backupCutoff,
      preflightExecutionFingerprint: preflight.executionFingerprint,
      readinessEvidenceFingerprint: preflight.readinessEvidenceFingerprint,
      promotionIntentSignature: preflight.intentSignature,
      candidateSetId: `restore-${'d'.repeat(20)}`,
      switchStrategy: 'VERSIONED_EXTERNAL_NAMED_VOLUMES',
      rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES',
      caddyPolicy: 'PRESERVE_CURRENT',
      productionMutationAllowed: false,
      promotionExecuted: false,
    });
    expect(record.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.activeVolumeSetFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.volumes).toEqual([
      {
        role: 'LIBSQL',
        restoreWorkspaceSubpath: 'libsql',
        activeVolumeName: activeVolumes.libsql,
        candidateVolumeName: `master-diagnostics-restore-${'d'.repeat(20)}-libsql`,
        rollbackVolumeName: activeVolumes.libsql,
      },
      {
        role: 'REPORTS',
        restoreWorkspaceSubpath: 'reports',
        activeVolumeName: activeVolumes.reports,
        candidateVolumeName: `master-diagnostics-restore-${'d'.repeat(20)}-reports`,
        rollbackVolumeName: activeVolumes.reports,
      },
      {
        role: 'TENANT_EXPORTS',
        restoreWorkspaceSubpath: 'tenant-exports',
        activeVolumeName: activeVolumes.tenantExports,
        candidateVolumeName: `master-diagnostics-restore-${'d'.repeat(20)}-tenant-exports`,
        rollbackVolumeName: activeVolumes.tenantExports,
      },
      {
        role: 'DATA_SUBJECT_DELIVERY',
        restoreWorkspaceSubpath: 'data-subject-delivery',
        activeVolumeName: activeVolumes.dataSubjectDelivery,
        candidateVolumeName: `master-diagnostics-restore-${'d'.repeat(20)}-data-subject-delivery`,
        rollbackVolumeName: activeVolumes.dataSubjectDelivery,
      },
    ]);
    expect(record.volumes.every((item) => (
      item.rollbackVolumeName === item.activeVolumeName
      && item.candidateVolumeName !== item.activeVolumeName
    ))).toBe(true);
  });

  it('persists a signed immutable plan and reuses it for the same preflight and active volumes', async () => {
    const { targetDir, keyFile } = await fixture();
    const first = await ensureSignedRestorePrivatePromotionExecutionPlan({
      targetDir,
      keyFile,
      preflight,
      activeVolumes,
    });
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(targetDir, RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME));
    expect(first.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    const second = await ensureSignedRestorePrivatePromotionExecutionPlan({
      targetDir,
      keyFile,
      preflight,
      activeVolumes,
    });
    expect(second.created).toBe(false);
    expect(second.envelope).toEqual(first.envelope);
    expect(await readVerifiedRestorePrivatePromotionExecutionPlan(
      first.path,
      keyFile,
      preflight,
      activeVolumes,
    )).toEqual(first.envelope);
  });

  it('fails closed when the active production volume set changes after planning', async () => {
    const { targetDir, keyFile } = await fixture();
    const created = await ensureSignedRestorePrivatePromotionExecutionPlan({
      targetDir,
      keyFile,
      preflight,
      activeVolumes,
    });
    const changed = Object.freeze({ ...activeVolumes, reports: 'master-diagnostics_report-data-v2' });
    await expect(readVerifiedRestorePrivatePromotionExecutionPlan(
      created.path,
      keyFile,
      preflight,
      changed,
    )).rejects.toThrow('does not match current preflight or active volumes');
    await expect(ensureSignedRestorePrivatePromotionExecutionPlan({
      targetDir,
      keyFile,
      preflight,
      activeVolumes: changed,
    })).rejects.toThrow();
  });

  it('rejects duplicate or unsafe active volume names before a plan can be created', () => {
    expect(() => createRestorePrivatePromotionExecutionPlanRecord(preflight, {
      ...activeVolumes,
      reports: activeVolumes.libsql,
    })).toThrow('must be distinct');
    expect(() => createRestorePrivatePromotionExecutionPlanRecord(preflight, {
      ...activeVolumes,
      reports: '../unsafe',
    })).toThrow('not a safe Docker volume name');
  });

  it('detects plan tampering before execution', async () => {
    const { targetDir, keyFile } = await fixture();
    const created = await ensureSignedRestorePrivatePromotionExecutionPlan({
      targetDir,
      keyFile,
      preflight,
      activeVolumes,
    });
    const parsed = JSON.parse(await readFile(created.path, 'utf8')) as {
      record: { caddyPolicy: string };
      signature: string;
    };
    parsed.record.caddyPolicy = 'RESTORE_FROM_BACKUP';
    await writeFile(created.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionExecutionPlan(
      created.path,
      keyFile,
      preflight,
      activeVolumes,
    )).rejects.toThrow('safety policy is invalid');
  });
});
