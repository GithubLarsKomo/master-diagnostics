import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

const MODE = 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_COPY' as const;
const CANDIDATE_ROOT = '/candidate';

const ROLE_SOURCE = Object.freeze({
  LIBSQL: Object.freeze({ subpath: 'libsql', root: '/restore-replay/libsql' }),
  REPORTS: Object.freeze({ subpath: 'reports', root: '/restore-replay/reports' }),
  TENANT_EXPORTS: Object.freeze({ subpath: 'tenant-exports', root: '/restore-replay/tenant-exports' }),
  DATA_SUBJECT_DELIVERY: Object.freeze({
    subpath: 'data-subject-delivery',
    root: '/restore-replay/data-subject-delivery',
  }),
});

type CandidateRole = keyof typeof ROLE_SOURCE;

interface TreeEntry {
  readonly path: string;
  readonly type: 'DIRECTORY' | 'FILE';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number | null;
  readonly sha256: `sha256:${string}` | null;
}

interface TreeSummary {
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

function requireRole(): CandidateRole {
  const value = process.env.RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE?.trim();
  if (!value || !(value in ROLE_SOURCE)) {
    throw new Error('RESTORE_PRIVATE_PROMOTION_CANDIDATE_ROLE is invalid');
  }
  return value as CandidateRole;
}

async function hashFile(filePath: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function collectTree(root: string): Promise<Readonly<TreeSummary>> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Promotion candidate tree root must be a non-symlink directory: ${root}`);
  }

  const entries: TreeEntry[] = [];
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
  const role = requireRole();
  const source = ROLE_SOURCE[role];
  const sourceSummary = await collectTree(source.root);

  await clearCandidateRoot();
  copyArchive(source.root);
  await chown(CANDIDATE_ROOT, sourceSummary.rootUid, sourceSummary.rootGid);
  await chmod(CANDIDATE_ROOT, sourceSummary.rootMode);

  const candidateSummary = await collectTree(CANDIDATE_ROOT);
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
