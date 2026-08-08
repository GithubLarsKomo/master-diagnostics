import { chmod, cp, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const RESTORE_STAGING_NAME_PATTERN = /^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RESTORE_WORK_NAME_PATTERN = /^restore-work-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PrepareRestoreReplayWorkInput {
  readonly stagingRoot: string;
  readonly stagingName: string;
  readonly workRoot: string;
  readonly workName: string;
}

function assertNames(stagingName: string, workName: string): void {
  if (!RESTORE_STAGING_NAME_PATTERN.test(stagingName)) throw new Error('Restore staging name is invalid');
  if (!RESTORE_WORK_NAME_PATTERN.test(workName)) throw new Error('Restore work name is invalid');
}

export async function prepareRestoreReplayWork(input: PrepareRestoreReplayWorkInput): Promise<string> {
  assertNames(input.stagingName, input.workName);
  const source = join(input.stagingRoot, input.stagingName, 'libsql');
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) throw new Error('Staged restore libSQL directory is missing');

  await mkdir(input.workRoot, { recursive: true, mode: 0o700 });
  await chmod(input.workRoot, 0o700);
  const workPath = join(input.workRoot, input.workName);
  const workInfo = await lstat(workPath).catch(() => null);
  if (workInfo) throw new Error('Restore replay work scope already exists');

  await mkdir(workPath, { mode: 0o700 });
  try {
    await cp(source, join(workPath, 'libsql'), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await chmod(workPath, 0o700);
    return workPath;
  } catch (error) {
    await rm(workPath, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupRestoreReplayWork(workRoot: string, workName: string): Promise<void> {
  if (!RESTORE_WORK_NAME_PATTERN.test(workName)) throw new Error('Restore work name is invalid');
  await rm(join(workRoot, workName), { recursive: true, force: true });
}
