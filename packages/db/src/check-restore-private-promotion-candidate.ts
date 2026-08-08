import {
  collectRestorePrivatePromotionTree,
  RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS,
  restorePrivatePromotionCandidateRole,
} from './services/restore-private-promotion-candidate-tree';

const MODE = 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_HEALTHCHECK' as const;
const CANDIDATE_ROOT = '/candidate';

async function main(): Promise<void> {
  const role = restorePrivatePromotionCandidateRole(
    process.env.RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE,
  );
  const source = RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS[role];
  const [sourceSummary, candidateSummary] = await Promise.all([
    collectRestorePrivatePromotionTree(source.sourceRoot),
    collectRestorePrivatePromotionTree(CANDIDATE_ROOT),
  ]);

  if (
    candidateSummary.fingerprint !== sourceSummary.fingerprint
    || candidateSummary.fileCount !== sourceSummary.fileCount
    || candidateSummary.directoryCount !== sourceSummary.directoryCount
    || candidateSummary.byteCount !== sourceSummary.byteCount
  ) {
    throw new Error('Promotion candidate healthcheck does not match the private restore source');
  }

  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    status: 'HEALTHY',
    role,
    sourceSubpath: source.subpath,
    candidateMutationAllowed: false,
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
  const message = error instanceof Error ? error.message : 'Restore promotion candidate healthcheck failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
