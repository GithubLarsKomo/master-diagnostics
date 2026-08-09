import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessRestorePrivatePromotionSwitchExecution,
  ensureSignedRestorePrivatePromotionSwitchExecutionEvent,
  readVerifiedRestorePrivatePromotionSwitchExecutionEvents,
  type RestorePrivatePromotionCurrentVolumeSet,
} from '../src/services/restore-private-promotion-switch-execution';
import type { SignedRestorePrivatePromotionSwitchJournalEnvelope } from '../src/services/restore-private-promotion-switch-journal';

const candidateSetId = 'restore-0123456789abcdefabcd';
const startedAt = '2026-08-09T09:00:00.000Z';

function journal(): Readonly<SignedRestorePrivatePromotionSwitchJournalEnvelope> {
  return Object.freeze({
    envelopeVersion: 1 as const,
    signature: `hmac-sha256:${'8'.repeat(64)}` as const,
    record: Object.freeze({
      journalVersion: 1 as const,
      phase: 'PENDING' as const,
      startedAt,
      switchIntentSignature: `hmac-sha256:${'7'.repeat(64)}` as const,
      switchAuthorizedAt: '2026-08-09T08:55:00.000Z',
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

const rollbackVolumes: Readonly<RestorePrivatePromotionCurrentVolumeSet> = Object.freeze({
  libsql: 'infra_libsql-data',
  reports: 'infra_report-data',
  tenantExports: 'infra_export-data',
  dataSubjectDelivery: 'infra_data-subject-delivery-data',
});

const candidateVolumes: Readonly<RestorePrivatePromotionCurrentVolumeSet> = Object.freeze({
  libsql: `master-diagnostics-${candidateSetId}-libsql`,
  reports: `master-diagnostics-${candidateSetId}-reports`,
  tenantExports: `master-diagnostics-${candidateSetId}-tenant-exports`,
  dataSubjectDelivery: `master-diagnostics-${candidateSetId}-data-subject-delivery`,
});

const partialCandidateVolumes: Readonly<RestorePrivatePromotionCurrentVolumeSet> = Object.freeze({
  ...rollbackVolumes,
  libsql: candidateVolumes.libsql,
});

const partialRollbackVolumes: Readonly<RestorePrivatePromotionCurrentVolumeSet> = Object.freeze({
  ...candidateVolumes,
  libsql: rollbackVolumes.libsql,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-switch-execution-'));
  const keyFile = join(root, 'promotion.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 97).toString('base64')}\n`, { mode: 0o600 });
  return { root, keyFile };
}

describe('restore private promotion switch execution evidence', () => {
  it('classifies a clean rollback-bound state as ready to start', async () => {
    const { root, keyFile } = await fixture();
    const evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(evidence).toEqual([]);
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'READY_TO_START',
      currentVolumeSet: 'ROLLBACK',
      nextAllowedEvents: ['CUTOVER_STARTED'],
      productionMutationAllowed: true,
      promotionExecuted: false,
    });
  });

  it('recovers exact and partial candidate activation after CUTOVER_STARTED', async () => {
    const { root, keyFile } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    const evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, candidateVolumes)).toMatchObject({
      status: 'RECOVER_CANDIDATE_SELECTION',
      currentVolumeSet: 'CANDIDATE',
      productionMutationAllowed: false,
    });
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, partialCandidateVolumes)).toMatchObject({
      status: 'READY_TO_SELECT_CANDIDATE',
      currentVolumeSet: 'MIXED_KNOWN',
      reason: 'CUTOVER_STARTED_WITH_PARTIAL_KNOWN_CANDIDATE_SELECTION',
      productionMutationAllowed: true,
    });
  });

  it('supports a successful candidate path through immutable chained evidence', async () => {
    const { root, keyFile } = await fixture();
    const first = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    const second = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    expect(second.envelope.record.previousEventSignature).toBe(first.envelope.signature);
    expect(second.envelope.record.sequence).toBe(2);
    let evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, candidateVolumes)).toMatchObject({
      status: 'VERIFY_CANDIDATE',
      nextAllowedEvents: ['COMPLETED', 'ROLLBACK_STARTED'],
    });

    const completed = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'COMPLETED', '2026-08-09T09:03:00.000Z');
    expect(completed.envelope.record.previousEventSignature).toBe(second.envelope.signature);
    expect(completed.envelope.record.targetVolumeSet).toBe('CANDIDATE');
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, candidateVolumes)).toMatchObject({
      status: 'COMPLETED',
      currentVolumeSet: 'CANDIDATE',
      promotionExecuted: true,
      nextAllowedEvents: [],
    });
  });

  it('supports rollback before a full candidate selection and recovers partial rollback', async () => {
    const { root, keyFile } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    const rollbackStarted = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_STARTED', '2026-08-09T09:02:00.000Z');
    expect(rollbackStarted.envelope.record.sequence).toBe(2);
    expect(rollbackStarted.envelope.record.targetVolumeSet).toBe('ROLLBACK');
    let evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, partialRollbackVolumes)).toMatchObject({
      status: 'READY_TO_SELECT_ROLLBACK',
      currentVolumeSet: 'MIXED_KNOWN',
      productionMutationAllowed: true,
    });
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'RECOVER_ROLLBACK_SELECTION',
      currentVolumeSet: 'ROLLBACK',
      productionMutationAllowed: false,
    });

    const selected = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_SELECTED', '2026-08-09T09:03:00.000Z');
    expect(selected.envelope.record.sequence).toBe(3);
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'VERIFY_ROLLBACK',
      nextAllowedEvents: ['ROLLBACK_VERIFIED'],
    });
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_VERIFIED', '2026-08-09T09:04:00.000Z');
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({ status: 'ROLLED_BACK' });
  });

  it('supports rollback after candidate selection with a five-step signed chain', async () => {
    const { root, keyFile } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_STARTED', '2026-08-09T09:03:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_SELECTED', '2026-08-09T09:04:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_VERIFIED', '2026-08-09T09:05:00.000Z');
    const evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(evidence.map((item) => item.record.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(evidence.map((item) => item.record.phase)).toEqual([
      'CUTOVER_STARTED', 'CANDIDATE_SELECTED', 'ROLLBACK_STARTED', 'ROLLBACK_SELECTED', 'ROLLBACK_VERIFIED',
    ]);
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({ status: 'ROLLED_BACK' });
  });

  it('blocks unknown volume names and rollback without ROLLBACK_STARTED evidence', async () => {
    const { root, keyFile } = await fixture();
    let evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, {
      ...rollbackVolumes,
      reports: 'unexpected_reports',
    })).toMatchObject({ status: 'BLOCKED', reason: 'ACTIVE_VOLUME_SET_UNKNOWN' });

    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'BLOCKED',
      reason: 'ACTIVE_SET_CONFLICTS_WITH_CANDIDATE_SELECTED_EVIDENCE',
    });
  });

  it('rejects illegal event transitions and event tampering', async () => {
    const { root, keyFile } = await fixture();
    await expect(ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_STARTED', '2026-08-09T09:01:00.000Z')).rejects.toThrow('is not allowed after current evidence');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    const second = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    const parsed = JSON.parse(await readFile(second.path, 'utf8')) as { record: { previousEventSignature: string | null }; signature: string };
    parsed.record.previousEventSignature = `hmac-sha256:${'f'.repeat(64)}`;
    await writeFile(second.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal())).rejects.toThrow();
  });
});
