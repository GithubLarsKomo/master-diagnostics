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

  it('recovers deterministically when candidate activation outruns its evidence write', async () => {
    const { root, keyFile } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(
      root,
      keyFile,
      journal(),
      'CUTOVER_STARTED',
      '2026-08-09T09:01:00.000Z',
    );
    const evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, candidateVolumes)).toMatchObject({
      status: 'RECOVER_CANDIDATE_SELECTION',
      currentVolumeSet: 'CANDIDATE',
      lastPhase: 'CUTOVER_STARTED',
      productionMutationAllowed: false,
    });
  });

  it('supports a successful candidate path through immutable chained evidence', async () => {
    const { root, keyFile } = await fixture();
    const first = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    const second = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    expect(second.envelope.record.previousEventSignature).toBe(first.envelope.signature);
    let evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, candidateVolumes)).toMatchObject({
      status: 'VERIFY_CANDIDATE',
      nextAllowedEvents: ['COMPLETED', 'ROLLBACK_SELECTED'],
    });

    const completed = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'COMPLETED', '2026-08-09T09:03:00.000Z');
    expect(completed.envelope.record.previousEventSignature).toBe(second.envelope.signature);
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, candidateVolumes)).toMatchObject({
      status: 'COMPLETED',
      currentVolumeSet: 'CANDIDATE',
      promotionExecuted: true,
      productionMutationAllowed: false,
      nextAllowedEvents: [],
    });
  });

  it('supports rollback and detects a crash after rollback selection but before its evidence write', async () => {
    const { root, keyFile } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    let evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'RECOVER_ROLLBACK_SELECTION',
      currentVolumeSet: 'ROLLBACK',
    });

    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_SELECTED', '2026-08-09T09:03:00.000Z');
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'VERIFY_ROLLBACK',
      nextAllowedEvents: ['ROLLBACK_VERIFIED'],
    });

    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'ROLLBACK_VERIFIED', '2026-08-09T09:04:00.000Z');
    evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, rollbackVolumes)).toMatchObject({
      status: 'ROLLED_BACK',
      promotionExecuted: false,
      nextAllowedEvents: [],
    });
  });

  it('blocks mixed active volume sets and illegal event transitions', async () => {
    const { root, keyFile } = await fixture();
    const evidence = await readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal());
    expect(assessRestorePrivatePromotionSwitchExecution(journal(), evidence, {
      ...rollbackVolumes,
      reports: candidateVolumes.reports,
    })).toMatchObject({
      status: 'BLOCKED',
      reason: 'ACTIVE_VOLUME_SET_MIXED_OR_UNKNOWN',
    });
    await expect(ensureSignedRestorePrivatePromotionSwitchExecutionEvent(
      root,
      keyFile,
      journal(),
      'CANDIDATE_SELECTED',
      '2026-08-09T09:01:00.000Z',
    )).rejects.toThrow('is not allowed after current evidence');
  });

  it('detects event tampering and broken signature chains', async () => {
    const { root, keyFile } = await fixture();
    await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CUTOVER_STARTED', '2026-08-09T09:01:00.000Z');
    const second = await ensureSignedRestorePrivatePromotionSwitchExecutionEvent(root, keyFile, journal(), 'CANDIDATE_SELECTED', '2026-08-09T09:02:00.000Z');
    const parsed = JSON.parse(await readFile(second.path, 'utf8')) as {
      record: { previousEventSignature: string | null };
      signature: string;
    };
    parsed.record.previousEventSignature = `hmac-sha256:${'f'.repeat(64)}`;
    await writeFile(second.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionSwitchExecutionEvents(root, keyFile, journal())).rejects.toThrow();
  });
});
