import { readdir, rm } from 'node:fs/promises';

const BACKUP_FILE_PATTERN = /^(masters-backup-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdbak)$/;

export const DEFAULT_BACKUP_RETENTION_COUNT = 30;

export interface BackupRetentionResult {
  readonly keepCount: number;
  readonly completeBackupCountBeforePrune: number;
  readonly keptCount: number;
  readonly prunedCount: number;
  readonly orphanBundleCount: number;
  readonly orphanChecksumCount: number;
}

export function parseBackupRetentionCount(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_BACKUP_RETENTION_COUNT;
  if (!/^[0-9]+$/.test(value)) throw new Error('BACKUP_RETENTION_COUNT must be an integer');
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 365) {
    throw new Error('BACKUP_RETENTION_COUNT must be between 1 and 365');
  }
  return count;
}

/**
 * Removes only complete, strictly named backup+checksum pairs older than the newest keepCount pairs.
 * Orphaned files are deliberately retained for operator review and do not count toward the bound.
 */
export async function pruneCompletedBackupBundles(
  targetDir: string,
  keepCount: number,
): Promise<BackupRetentionResult> {
  if (!Number.isSafeInteger(keepCount) || keepCount < 1 || keepCount > 365) {
    throw new Error('Backup retention count must be between 1 and 365');
  }

  const entries = await readdir(targetDir, { withFileTypes: true });
  const regularFiles = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const bundleNames = [...regularFiles]
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort((left, right) => right.localeCompare(left));
  const checksumNames = [...regularFiles].filter((name) => {
    if (!name.endsWith('.mdbak.sha256')) return false;
    return BACKUP_FILE_PATTERN.test(name.slice(0, -'.sha256'.length));
  });

  const completePairs = bundleNames.filter((name) => regularFiles.has(`${name}.sha256`));
  const orphanBundleCount = bundleNames.length - completePairs.length;
  const completeSet = new Set(completePairs);
  const orphanChecksumCount = checksumNames.filter((name) => {
    const bundleName = name.slice(0, -'.sha256'.length);
    return !completeSet.has(bundleName);
  }).length;

  const stalePairs = completePairs.slice(keepCount);
  for (const bundleName of stalePairs) {
    // Delete the sensitive bundle first. A sidecar-only residue contains no backed-up domain data.
    await rm(`${targetDir}/${bundleName}`);
    await rm(`${targetDir}/${bundleName}.sha256`);
  }

  return Object.freeze({
    keepCount,
    completeBackupCountBeforePrune: completePairs.length,
    keptCount: Math.min(completePairs.length, keepCount),
    prunedCount: stalePairs.length,
    orphanBundleCount,
    orphanChecksumCount,
  });
}
