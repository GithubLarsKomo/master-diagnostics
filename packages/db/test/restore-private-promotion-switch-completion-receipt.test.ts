import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SignedRestoreSourceProvenanceEnvelope } from '../src/services/backup-restore-source-provenance';
import {
  createRestorePrivatePromotionSwitchCompletionReceiptRecord,
  ensureSignedRestorePrivatePromotionSwitchCompletionReceipt,
  readVerifiedRestorePrivatePromotionSwitchCompletionReceipt,
  type RestorePrivatePromotionPostSwitchHealthcheck,
} from '../src/services/restore-private-promotion-switch-completion-receipt';
import {
  ensureSignedRestorePrivatePromotionSwitchExecutionEvent,
  readVerifiedRestorePrivatePromotionSwitchExecutionEvents,
} from '../src/services/restore-private-promotion-switch-execution';
import type { SignedRestorePrivatePromotionSwitchJournalEnvelope } from '../src/services/restore-private-promotion-switch-journal';

const candidateSetId = 'restore-0123456789abcdefabcd';

function sourceProvenance(overrides: Partial<SignedRestoreSourceProvenanceEnvelope['record']> = {}): Readonly<SignedRestoreSourceProvenanceEnvelope> {
  return Object.freeze({
    envelopeVersion: 1 as const,
    signature: `hmac-sha256:${'6'.repeat(64)}` as const,
    record: Object.freeze({
      provenanceVersion: 1 as const,
      stagingName: 'restore-20260806T050000000Z-12345678-1234-1234-1234-123456789abc',
      backupFileName: 'masters-backup-20260806T050000000Z-12345678-1234-1234-1234-123456789abc.mdbak',
      backupSha256: `sha256:${'5'.repeat(64)}` as const,
      backupCreatedAt: '2026-08-06T05:00:00.000Z',
      backupManifestFingerprint: `sha256:${'4'.repeat(64)}` as const,
      bundleVersion: 1 as const,
      consistency: 'CLEANLY_STOPPED_VOLUMES' as const,
      restoreReconciliationRequired: true as const,
      sourceNames: Object.freeze(['libsql', 'reports', 'tenant-exports', 'data-subject-delivery', 'caddy-data', 'caddy-config']),
      ...overrides,
    }),
  });
}

function journal(): Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope> {
  return Object.freeze({
    envelopeVersion: 1 as const,
    signature: `hmac-sha256:${'8'.repeat(64)}` as const,
    record: Object.freeze({
      journalVersion: 1 as const,
      phase: 'PENDING' as const,
      startedAt: '2026-08-09T11:00:00.000Z',
      switchIntentSignature: `hmac-sha256:${'7'.repeat(64)}` as const,
      switchAuthorizedAt: '2026-08-09T10:55:00.000Z',
      candidateSetFingerprint: `sha256:${'a'.repeat(64)}` as const,
      planFingerprint: `sha256:${'b'.repeat(64)}` as const,
      activeVolumeSetFingerprint: `sha256:${'c'.repeat(64)}` as const,
      candidateSetId,
      selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1' as const,
      selectorOverride: 'infra/docker-compose.restore-promotion-selector.yml' as const,
      rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES' as const,
      caddyPolicy: 'PRESERVE_CURRENT' as const,
      crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION' as const,
      rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER' as const,
      completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK' as const,
      journalPersistenceScope: 'HOST_DURABLE_OUTSIDE_RESTORE_WORKSPACE' as const,
      journalRequiredBeforeMutation: true as const,
      rollbackVolumesMustRemain: true as const,
      productionSwitchAuthorized: true as const,
      productionMutationStarted: false as const,
      promotionExecuted: false as const,
      volumes: Object.freeze([
        Object.freeze({ role: 'LIBSQL' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-libsql`, rollbackVolumeName: 'infra_libsql-data', treeFingerprint: `sha256:${'1'.repeat(64)}` as const }),
        Object.freeze({ role: 'REPORTS' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-reports`, rollbackVolumeName: 'infra_report-data', treeFingerprint: `sha256:${'2'.repeat(64)}` as const }),
        Object.freeze({ role: 'TENANT_EXPORTS' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-tenant-exports`, rollbackVolumeName: 'infra_export-data', treeFingerprint: `sha256:${'3'.repeat(64)}` as const }),
        Object.freeze({ role: 'DATA_SUBJECT_DELIVERY' as const, candidateVolumeName: `master-diagnostics-${candidateSetId}-data-subject-delivery`, rollbackVolumeName: 'infra_data-subject-delivery-data', treeFingerprint: `sha256:${'4'.repeat(64)}` as const }),
      ]),
      journalFingerprint: `sha256:${'d'.repeat(64)}` as const,
    }),
  });
}

function healthcheck(overrides: Partial<RestorePrivatePromotionPostSwitchHealthcheck> = {}): Readonly<RestorePrivatePromotionPostSwitchHealthcheck> {
  return Object.freeze({
    mode: 'CLUB_RESTORE_PROMOTION_POST_SWITCH_HEALTHCHECK' as const,
    status: 'HEALTHY' as const,
    healthcheckVersion: 1 as const,
    checkedAt: '2026-08-09T11:05:00.000Z',
    candidateSetId,
    currentVolumeSet: 'CANDIDATE' as const,
    libsqlHealth: 'HEALTHY' as const,
    appHealth: 'HEALTHY' as const,
    exportCleanupRunning: true as const,
    retentionScanRunning: true as const,
    caddyPreserved: true as const,
    rollbackVolumesRetained: true as const,
    candidateVolumes: Object.freeze(journal().record.volumes.map((item) => Object.freeze({ role: item.role, volumeName: item.candidateVolumeName }))),
    ...overrides,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-switch-completion-'));
  const keyFile = join(root, 'promotion.key');
  const evidenceDir = join(root, 'evidence');
  await writeFile(keyFile, `${Buffer.alloc(32, 121).toString('base64')}\n`, { mode: 0o600 });
  await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(evidenceDir, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T11:01:00.000Z');
  await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(evidenceDir, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T11:02:00.000Z');
  const events = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(evidenceDir, keyFile, journal());
  return { root, keyFile, evidenceDir, events };
}

describe('restore private promotion switch completion receipt', () => {
  it('binds source provenance, health and candidate evidence', async () => {
    const { events } = await fixture();
    const record = createRestorePrivatePromotionSwitchCompletionReceiptRecord(journal(), events, healthcheck(), sourceProvenance(), '2026-08-09T11:06:00.000Z');
    expect(record).toMatchObject({
      receiptVersion: 1,
      status: 'PROMOTED',
      candidateSetId,
      sourceProvenanceSignature: sourceProvenance().signature,
      sourceStagingName: sourceProvenance().record.stagingName,
      sourceBackupFileName: sourceProvenance().record.backupFileName,
      sourceBackupSha256: sourceProvenance().record.backupSha256,
      sourceBackupCreatedAt: sourceProvenance().record.backupCreatedAt,
      sourceBackupManifestFingerprint: sourceProvenance().record.backupManifestFingerprint,
      currentVolumeSet: 'CANDIDATE',
      productionMutationCompleted: true,
      promotionExecuted: true,
    });
    expect(record.candidateSelectedEventSignature).toBe(events.at(-1)?.signature);
    expect(record.postSwitchHealthcheckFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('persists immutable receipt and rejects provenance drift on retry', async () => {
    const { keyFile, evidenceDir, events } = await fixture();
    const first = await ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(evidenceDir, keyFile, journal(), events, healthcheck(), sourceProvenance(), '2026-08-09T11:06:00.000Z');
    expect(first.created).toBe(true);
    const second = await ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(evidenceDir, keyFile, journal(), events, healthcheck(), sourceProvenance(), '2026-08-09T11:10:00.000Z');
    expect(second.created).toBe(false);
    expect(second.envelope).toEqual(first.envelope);
    expect(await readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(first.path, keyFile, journal(), events)).toEqual(first.envelope);
    await expect(ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(
      evidenceDir, keyFile, journal(), events, healthcheck(),
      sourceProvenance({ backupSha256: `sha256:${'f'.repeat(64)}` }),
      '2026-08-09T11:10:00.000Z',
    )).rejects.toThrow('does not match verified restore source provenance');
  });

  it('remains verifiable after COMPLETED but cannot be newly created after completion', async () => {
    const { keyFile, evidenceDir, events } = await fixture();
    const receipt = await ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(evidenceDir, keyFile, journal(), events, healthcheck(), sourceProvenance(), '2026-08-09T11:06:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(evidenceDir, keyFile, journal(), 'COMPLETED', '2026-08-09T11:07:00.000Z');
    const completedEvents = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(evidenceDir, keyFile, journal());
    expect(await readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(receipt.path, keyFile, journal(), completedEvents)).toEqual(receipt.envelope);

    const freshRoot = await mkdtemp(join(tmpdir(), 'restore-switch-completion-late-'));
    const freshKey = join(freshRoot, 'promotion.key');
    const freshEvidence = join(freshRoot, 'evidence');
    await writeFile(freshKey, `${Buffer.alloc(32, 121).toString('base64')}\n`, { mode: 0o600 });
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(freshEvidence, freshKey, journal(), 'CUTOVER_STARTED', '2026-08-09T11:01:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(freshEvidence, freshKey, journal(), 'CANDIDATE_SELECTED', '2026-08-09T11:02:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(freshEvidence, freshKey, journal(), 'COMPLETED', '2026-08-09T11:07:00.000Z');
    const lateEvents = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(freshEvidence, freshKey, journal());
    await expect(ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(freshEvidence, freshKey, journal(), lateEvents, healthcheck(), sourceProvenance(), '2026-08-09T11:08:00.000Z')).rejects.toThrow('incompatible with rollback or non-completion execution evidence');
  });

  it('rejects unhealthy, mismatched, or malformed source evidence', async () => {
    const { events } = await fixture();
    expect(() => createRestorePrivatePromotionSwitchCompletionReceiptRecord(journal(), events, healthcheck({ appHealth: 'BROKEN' as 'HEALTHY' }), sourceProvenance(), '2026-08-09T11:06:00.000Z')).toThrow('requires a healthy post-switch report');
    expect(() => createRestorePrivatePromotionSwitchCompletionReceiptRecord(journal(), events, healthcheck({ candidateSetId: 'restore-fedcba9876543210abcd' }), sourceProvenance(), '2026-08-09T11:06:00.000Z')).toThrow('candidate-set ID does not match');
    expect(() => createRestorePrivatePromotionSwitchCompletionReceiptRecord(journal(), events, healthcheck(), sourceProvenance({ backupFileName: 'wrong.mdbak' }), '2026-08-09T11:06:00.000Z')).toThrow('backup file name is invalid');
  });

  it('rejects rollback evidence as a completion source', async () => {
    const { root, keyFile, evidenceDir } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(evidenceDir, keyFile, journal(), 'ROLLBACK_STARTED', '2026-08-09T11:03:00.000Z');
    const events = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(evidenceDir, keyFile, journal());
    expect(() => createRestorePrivatePromotionSwitchCompletionReceiptRecord(journal(), events, healthcheck(), sourceProvenance(), '2026-08-09T11:06:00.000Z')).toThrow('incompatible with rollback or non-completion execution evidence');
    expect(root).toBeTruthy();
  });

  it('detects persisted receipt tampering', async () => {
    const { keyFile, evidenceDir, events } = await fixture();
    const created = await ensureSignedRestorePrivatePromotionSwitchCompletionReceipt(evidenceDir, keyFile, journal(), events, healthcheck(), sourceProvenance(), '2026-08-09T11:06:00.000Z');
    const parsed = JSON.parse(await readFile(created.path, 'utf8')) as { record: { sourceBackupSha256: string }; signature: string };
    parsed.record.sourceBackupSha256 = `sha256:${'f'.repeat(64)}`;
    await writeFile(created.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionSwitchCompletionReceipt(created.path, keyFile, journal(), events)).rejects.toThrow('signature verification failed');
  });
});
