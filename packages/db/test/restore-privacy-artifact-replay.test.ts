import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRestorePrivacyArtifactReplay,
  persistRestorePrivacyArtifactReplayResult,
  readVerifiedRestorePrivacyArtifactReplayResultIfPresent,
  restorePrivacyArtifactReplayResultForManifest,
} from '../src/services/restore-privacy-artifact-replay';
import type {
  RestorePrivacyArtifactReplayEntry,
  RestorePrivacyArtifactReplayManifest,
} from '../src/services/restore-privacy-artifact-replay-manifest';

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifestWithEntries(
  entries: readonly Readonly<RestorePrivacyArtifactReplayEntry>[],
): Readonly<RestorePrivacyArtifactReplayManifest> {
  const canonicalEntries = Object.freeze(
    [...entries].sort((left, right) => [
      left.kind,
      left.tenantId,
      left.athleteId ?? '',
      left.storageReference,
    ].join('\n').localeCompare([
      right.kind,
      right.tenantId,
      right.athleteId ?? '',
      right.storageReference,
    ].join('\n'))),
  );
  return Object.freeze({
    manifestVersion: 1,
    backupCutoff: '2026-08-01T00:00:00.000Z',
    reconciliationStatus: canonicalEntries.length === 0 ? 'CLEAR' : 'REPLAY_REQUIRED',
    ledgerGeneratedAt: '2026-08-08T00:00:00.000Z',
    ledgerEntriesFingerprint: `sha256:${'1'.repeat(64)}`,
    journalMarkerCount: canonicalEntries.length === 0 ? 0 : 2,
    obligationCount: canonicalEntries.length === 0 ? 0 : 1,
    obligationsFingerprint: `sha256:${'2'.repeat(64)}`,
    entryCount: canonicalEntries.length,
    entriesFingerprint: sha256(JSON.stringify(canonicalEntries)),
    entries: canonicalEntries,
  });
}

async function roots() {
  const workspace = await mkdtemp(join(tmpdir(), 'restore-artifact-replay-'));
  const reportRoot = join(workspace, 'reports');
  const tenantExportRoot = join(workspace, 'tenant-exports');
  const dataSubjectDeliveryRoot = join(workspace, 'data-subject-delivery');
  await Promise.all([
    mkdir(reportRoot, { recursive: true }),
    mkdir(tenantExportRoot, { recursive: true }),
    mkdir(dataSubjectDeliveryRoot, { recursive: true }),
  ]);
  return { workspace, reportRoot, tenantExportRoot, dataSubjectDeliveryRoot };
}

async function put(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

const reportReference = `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`;
const tenantExportReference = '11111111-1111-1111-1111-111111111111.mde';
const dataSubjectReference = '33333333-3333-3333-3333-333333333333.mdse';

function replayManifest(): Readonly<RestorePrivacyArtifactReplayManifest> {
  return manifestWithEntries([
    {
      kind: 'REPORT', tenantId: 'tenant-a', athleteId: 'athlete-a',
      storageReference: reportReference, executionIds: ['execution-after-backup-a'],
    },
    {
      kind: 'TENANT_EXPORT', tenantId: 'tenant-a', athleteId: null,
      storageReference: tenantExportReference, executionIds: ['execution-after-backup-a'],
    },
    {
      kind: 'DATA_SUBJECT_DELIVERY', tenantId: 'tenant-a', athleteId: 'athlete-a',
      storageReference: dataSubjectReference, executionIds: ['execution-after-backup-a'],
    },
  ]);
}

describe('restore privacy artifact replay', () => {
  it('removes only manifest-bound active artifacts and proves retryable absence', async () => {
    const storage = await roots();
    const manifest = replayManifest();
    const reportPath = join(storage.reportRoot, reportReference);
    const tenantExportPath = join(storage.tenantExportRoot, tenantExportReference);
    const dataSubjectPath = join(storage.dataSubjectDeliveryRoot, dataSubjectReference);
    const unrelatedPath = join(storage.reportRoot, `tenant-a/test-b/de/${'e'.repeat(64)}.pdf`);
    const quarantinePath = join(
      storage.reportRoot,
      '.anonymization-quarantine',
      'execution-before-backup-a',
      reportReference,
    );

    await Promise.all([
      put(reportPath, 'private report'),
      put(tenantExportPath, 'private tenant export'),
      put(dataSubjectPath, 'private data subject package'),
      put(unrelatedPath, 'keep me'),
      put(quarantinePath, 'pre-existing quarantine is a later healthcheck concern'),
    ]);

    const first = await applyRestorePrivacyArtifactReplay(manifest, storage);
    expect(first.removedCount).toBe(3);
    expect(first.alreadyAbsentCount).toBe(0);
    expect(first.result.verifiedAbsentCount).toBe(3);
    expect(first.result.promotionAllowed).toBe(false);
    await expect(access(reportPath)).rejects.toThrow();
    await expect(access(tenantExportPath)).rejects.toThrow();
    await expect(access(dataSubjectPath)).rejects.toThrow();
    expect(await readFile(unrelatedPath, 'utf8')).toBe('keep me');
    expect(await readFile(quarantinePath, 'utf8')).toContain('later healthcheck');

    const second = await applyRestorePrivacyArtifactReplay(manifest, storage);
    expect(second.removedCount).toBe(0);
    expect(second.alreadyAbsentCount).toBe(3);
    expect(second.result).toEqual(first.result);
  });

  it('persists a deterministic 0600 result and blocks evidence replacement', async () => {
    const storage = await roots();
    const manifest = manifestWithEntries([]);
    const applied = await applyRestorePrivacyArtifactReplay(manifest, storage);
    const resultPath = join(storage.workspace, 'artifact-replay-result.json');

    expect((await persistRestorePrivacyArtifactReplayResult(resultPath, applied.result, manifest)).created).toBe(true);
    expect((await persistRestorePrivacyArtifactReplayResult(resultPath, applied.result, manifest)).created).toBe(false);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
    expect((await stat(storage.workspace)).mode & 0o777).toBe(0o700);
    expect(await readVerifiedRestorePrivacyArtifactReplayResultIfPresent(resultPath, manifest)).toEqual(applied.result);

    const changedManifest = Object.freeze({
      ...manifest,
      obligationsFingerprint: `sha256:${'f'.repeat(64)}` as const,
    });
    const changedResult = restorePrivacyArtifactReplayResultForManifest(changedManifest);
    await expect(persistRestorePrivacyArtifactReplayResult(resultPath, changedResult, changedManifest))
      .rejects.toThrow(/different content/);
  });

  it('rejects symlink-backed parent paths before deleting outside the private root', async () => {
    const storage = await roots();
    const outside = await mkdtemp(join(tmpdir(), 'restore-artifact-outside-'));
    const outsideReport = join(outside, 'test-a', 'de', `${'d'.repeat(64)}.pdf`);
    await put(outsideReport, 'must survive');
    await symlink(outside, join(storage.reportRoot, 'tenant-a'));

    const manifest = manifestWithEntries([{
      kind: 'REPORT',
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      storageReference: reportReference,
      executionIds: ['execution-after-backup-a'],
    }]);

    await expect(applyRestorePrivacyArtifactReplay(manifest, storage))
      .rejects.toThrow(/symlink-backed/i);
    expect(await readFile(outsideReport, 'utf8')).toBe('must survive');
  });
});
