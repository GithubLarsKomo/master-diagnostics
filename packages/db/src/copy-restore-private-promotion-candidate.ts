import { spawnSync } from 'node:child_process';
import { chmod, chown, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectRestorePrivatePromotionTree,
  RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS,
  restorePrivatePromotionCandidateRole,
} from './services/restore-private-promotion-candidate-tree';

const MODE = 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_COPY' as const;
const CANDIDATE_ROOT = '/candidate';

async function clearCandidateRoot(): Promise<void> {
  const stat = await lstat(CANDIDATE_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Promotion candidate mount must be a non-symlink directory');
  }
  const names = await readdir(CANDIDATE_ROOT);
  for (const name of names) {
    await rm(join(CANDIDATE_ROOT, name), { recursive: true, force: true });
  }
}

function copyArchive(sourceRoot: string): void {
  const result = spawnSync('cp', ['-a', `${sourceRoot}/.`, `${CANDIDATE_ROOT}/`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Promotion candidate copy failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

async function main(): Promise<void> {
  const role = restorePrivatePromotionCandidateRole(
    process.env.RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE,
  );
  const source = RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS[role];
  const sourceSummary = await collectRestorePrivatePromotionTree(source.sourceRoot);

  await clearCandidateRoot();
  copyArchive(source.sourceRoot);
  await chown(CANDIDATE_ROOT, sourceSummary.rootUid, sourceSummary.rootGid);
  await chmod(CANDIDATE_ROOT, sourceSummary.rootMode);

  const candidateSummary = await collectRestorePrivatePromotionTree(CANDIDATE_ROOT);
  if (
    candidateSummary.fingerprint !== sourceSummary.fingerprint
    || candidateSummary.fileCount !== sourceSummary.fileCount
    || candidateSummary.directoryCount !== sourceSummary.directoryCount
    || candidateSummary.byteCount !== sourceSummary.byteCount
  ) {
    throw new Error('Promotion candidate tree does not match the private restore source');
  }

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'COPIED_AND_VERIFIED',
    role,
    sourceSubpath: source.subpath,
    candidateMutationApplied: true,
    productionMutationAllowed: false,
    promotionExecuted: false,
    sourceFingerprint: sourceSummary.fingerprint,
    candidateFingerprint: candidateSummary.fingerprint,
    fileCount: sourceSummary.fileCount,
    directoryCount: sourceSummary.directoryCount,
    byteCount: sourceSummary.byteCount,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore promotion candidate copy failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
