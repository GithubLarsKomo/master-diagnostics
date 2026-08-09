import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRestorePrivatePromotionSwitchJournalRecord,
  ensureSignedRestorePrivatePromotionSwitchJournal,
  readVerifiedRestorePrivatePromotionSwitchJournal,
  RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME,
} from '../src/services/restore-private-promotion-switch-journal';
import type { SignedRestorePrivatePromotionSwitchIntentEnvelope } from '../src/services/restore-private-promotion-switch-intent';

const authorizedAt = '2026-08-09T08:00:00.000Z';
const startedAt = '2026-08-09T08:05:00.000Z';

function switchIntent(
  reportCandidate = 'master-diagnostics-restore-0123456789abcdefabcd-reports',
): Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope> {
  return Object.freeze({
    envelopeVersion: 1 as const,
    signature: `hmac-sha256:${'9'.repeat(64)}` as const,
    record: Object.freeze({
      switchIntentVersion: 1 as const,
      phase: 'PENDING' as const,
      authorizedAt,
      candidateHealthcheckVersion: 1 as const,
      candidateSetFingerprint: `sha256:${'a'.repeat(64)}` as const,
      planFingerprint: `sha256:${'b'.repeat(64)}` as const,
      activeVolumeSetFingerprint: `sha256:${'c'.repeat(64)}` as const,
      candidateSetId: 'restore-0123456789abcdefabcd',
      selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1' as const,
      rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES' as const,
      caddyPolicy: 'PRESERVE_CURRENT' as const,
      crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION' as const,
      rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER' as const,
      completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK' as const,
      preSwitchHealthcheckRequired: true as const,
      rollbackVolumesMustRemain: true as const,
      productionSwitchAuthorized: true as const,
      promotionExecuted: false as const,
      volumes: Object.freeze([
        Object.freeze({
          role: 'LIBSQL' as const,
          candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-libsql',
          rollbackVolumeName: 'infra_libsql-data',
          treeFingerprint: `sha256:${'1'.repeat(64)}` as const,
        }),
        Object.freeze({
          role: 'REPORTS' as const,
          candidateVolumeName: reportCandidate,
          rollbackVolumeName: 'infra_report-data',
          treeFingerprint: `sha256:${'2'.repeat(64)}` as const,
        }),
        Object.freeze({
          role: 'TENANT_EXPORTS' as const,
          candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-tenant-exports',
          rollbackVolumeName: 'infra_export-data',
          treeFingerprint: `sha256:${'3'.repeat(64)}` as const,
        }),
        Object.freeze({
          role: 'DATA_SUBJECT_DELIVERY' as const,
          candidateVolumeName: 'master-diagnostics-restore-0123456789abcdefabcd-data-subject-delivery',
          rollbackVolumeName: 'infra_data-subject-delivery-data',
          treeFingerprint: `sha256:${'4'.repeat(64)}` as const,
        }),
      ]),
    }),
  });
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-promotion-switch-journal-'));
  const targetDir = join(workspace, 'journal');
  const keyFile = join(workspace, 'promotion.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 83).toString('base64')}\n`, { mode: 0o600 });
  return { targetDir, keyFile };
}

describe('restore private promotion switch journal', () => {
  it('binds the switch intent to a durable pre-mutation PENDING contract', () => {
    const intent = switchIntent();
    const record = createRestorePrivatePromotionSwitchJournalRecord(intent, startedAt);
    expect(record).toMatchObject({
      journalVersion: 1,
      phase: 'PENDING',
      startedAt,
      switchIntentSignature: intent.signature,
      switchAuthorizedAt: authorizedAt,
      candidateSetFingerprint: intent.record.candidateSetFingerprint,
      planFingerprint: intent.record.planFingerprint,
      activeVolumeSetFingerprint: intent.record.activeVolumeSetFingerprint,
      candidateSetId: intent.record.candidateSetId,
      selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1',
      selectorOverride: 'infra/docker-compose.restore-promotion-selector.yml',
      rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES',
      caddyPolicy: 'PRESERVE_CURRENT',
      crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION',
      rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER',
      completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK',
      journalPersistenceScope: 'HOST_DURABLE_OUTSIDE_RESTORE_WORKSPACE',
      journalRequiredBeforeMutation: true,
      rollbackVolumesMustRemain: true,
      productionSwitchAuthorized: true,
      productionMutationStarted: false,
      promotionExecuted: false,
    });
    expect(record.journalFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.volumes).toEqual(intent.record.volumes);
  });

  it('persists 0700/0600 signed evidence and reuses the original PENDING journal', async () => {
    const { targetDir, keyFile } = await fixture();
    const intent = switchIntent();
    const first = await ensureSignedRestorePrivatePromotionSwitchJournal({
      targetDir,
      keyFile,
      switchIntent: intent,
      startedAt,
    });
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE_NAME));
    expect(first.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect((await stat(targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    const second = await ensureSignedRestorePrivatePromotionSwitchJournal({
      targetDir,
      keyFile,
      switchIntent: intent,
      startedAt: '2026-08-09T08:10:00.000Z',
    });
    expect(second.created).toBe(false);
    expect(second.envelope).toEqual(first.envelope);
    expect(second.envelope.record.startedAt).toBe(startedAt);
    expect(await readVerifiedRestorePrivatePromotionSwitchJournal(first.path, keyFile, intent)).toEqual(first.envelope);
  });

  it('fails closed when a different switch intent targets the same durable journal', async () => {
    const { targetDir, keyFile } = await fixture();
    const original = switchIntent();
    const created = await ensureSignedRestorePrivatePromotionSwitchJournal({
      targetDir,
      keyFile,
      switchIntent: original,
      startedAt,
    });
    const changed = switchIntent('master-diagnostics-restore-fedcba9876543210abcd-reports');
    await expect(readVerifiedRestorePrivatePromotionSwitchJournal(created.path, keyFile, changed)).rejects.toThrow(
      'does not match signed switch intent',
    );
    await expect(ensureSignedRestorePrivatePromotionSwitchJournal({
      targetDir,
      keyFile,
      switchIntent: changed,
      startedAt: '2026-08-09T08:15:00.000Z',
    })).rejects.toThrow();
  });

  it('rejects unsafe switch intent policy and journal timestamps before authorization', () => {
    const intent = switchIntent();
    expect(() => createRestorePrivatePromotionSwitchJournalRecord({
      ...intent,
      record: { ...intent.record, promotionExecuted: true },
    } as unknown as SignedRestorePrivatePromotionSwitchIntentEnvelope, startedAt)).toThrow(
      'not eligible for durable journal preparation',
    );
    expect(() => createRestorePrivatePromotionSwitchJournalRecord(intent, '2026-08-09T07:59:59.000Z')).toThrow(
      'cannot start before switch authorization',
    );
  });

  it('detects persisted safety-policy tampering before a future executor can consume the journal', async () => {
    const { targetDir, keyFile } = await fixture();
    const intent = switchIntent();
    const created = await ensureSignedRestorePrivatePromotionSwitchJournal({
      targetDir,
      keyFile,
      switchIntent: intent,
      startedAt,
    });
    const parsed = JSON.parse(await readFile(created.path, 'utf8')) as {
      record: { productionMutationStarted: boolean };
      signature: string;
    };
    parsed.record.productionMutationStarted = true;
    await writeFile(created.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionSwitchJournal(created.path, keyFile, intent)).rejects.toThrow(
      'safety policy is invalid',
    );
  });
});
