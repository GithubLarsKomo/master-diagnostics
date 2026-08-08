import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS = Object.freeze({
  LIBSQL: Object.freeze({ subpath: 'libsql' as const, sourceRoot: '/restore-replay/libsql' }),
  REPORTS: Object.freeze({ subpath: 'reports' as const, sourceRoot: '/restore-replay/reports' }),
  TENANT_EXPORTS: Object.freeze({
    subpath: 'tenant-exports' as const,
    sourceRoot: '/restore-replay/tenant-exports',
  }),
  DATA_SUBJECT_DELIVERY: Object.freeze({
    subpath: 'data-subject-delivery' as const,
    sourceRoot: '/restore-replay/data-subject-delivery',
  }),
});

export type RestorePrivatePromotionCandidateRole = keyof typeof RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS;

interface RestorePrivatePromotionTreeEntry {
  readonly path: string;
  readonly type: 'DIRECTORY' | 'FILE';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number | null;
  readonly sha256: `sha256:${string}` | null;
}

export interface RestorePrivatePromotionTreeSummary {
  readonly fingerprint: `sha256:${string}`;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly byteCount: number;
  readonly rootMode: number;
  readonly rootUid: number;
  readonly rootGid: number;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function hashFile(filePath: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function restorePrivatePromotionCandidateRole(
  value: string | undefined,
): RestorePrivatePromotionCandidateRole {
  const role = value?.trim();
  if (!role || !(role in RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE_SPECS)) {
    throw new Error('RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE is invalid');
  }
  return role as RestorePrivatePromotionCandidateRole;
}

export async function collectRestorePrivatePromotionTree(
  root: string,
): Promise<Readonly<RestorePrivatePromotionTreeSummary>> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Promotion candidate tree root must be a non-symlink directory: ${root}`);
  }

  const entries: RestorePrivatePromotionTreeEntry[] = [];
  let fileCount = 0;
  let directoryCount = 1;
  let byteCount = 0;

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    const names = (await readdir(absoluteDir)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const absolutePath = join(absoluteDir, name);
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Promotion candidate source contains a symlink: ${relativePath}`);
      }
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        directoryCount += 1;
        entries.push(Object.freeze({
          path: relativePath,
          type: 'DIRECTORY',
          mode,
          uid: stat.uid,
          gid: stat.gid,
          size: null,
          sha256: null,
        }));
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Promotion candidate source contains an unsupported file type: ${relativePath}`);
      }
      fileCount += 1;
      byteCount += stat.size;
      entries.push(Object.freeze({
        path: relativePath,
        type: 'FILE',
        mode,
        uid: stat.uid,
        gid: stat.gid,
        size: stat.size,
        sha256: await hashFile(absolutePath),
      }));
    }
  };

  await walk(root, '');
  const canonical = {
    root: {
      mode: rootStat.mode & 0o7777,
      uid: rootStat.uid,
      gid: rootStat.gid,
    },
    entries,
  };
  return Object.freeze({
    fingerprint: sha256(JSON.stringify(canonical)),
    fileCount,
    directoryCount,
    byteCount,
    rootMode: canonical.root.mode,
    rootUid: canonical.root.uid,
    rootGid: canonical.root.gid,
  });
}
