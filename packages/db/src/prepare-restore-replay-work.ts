import { chmod, cp, lstat, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const STAGING_NAME = /^restore-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORK_NAME = /^restore-work-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type WorkAction = 'prepare' | 'cleanup';

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requiredName(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredAction(): WorkAction {
  const value = process.env.RESTORE_WORK_ACTION?.trim();
  if (value !== 'prepare' && value !== 'cleanup') throw new Error('RESTORE_WORK_ACTION must be prepare or cleanup');
  return value;
}

async function prepare(stagingRoot: string, stagingName: string, workRoot: string, workName: string) {
  const source = join(stagingRoot, stagingName, 'libsql');
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) throw new Error('Staged restore libSQL directory is missing');

  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  await chmod(workRoot, 0o700);
  const workPath = join(workRoot, workName);
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
    process.stdout.write(`${JSON.stringify({ action: 'prepare', workName })}\n`);
  } catch (error) {
    await rm(workPath, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup(workRoot: string, workName: string) {
  await rm(join(workRoot, workName), { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ action: 'cleanup', workName })}\n`);
}

async function main(): Promise<void> {
  const action = requiredAction();
  const workRoot = requiredPath('RESTORE_WORK_ROOT');
  const workName = requiredName('RESTORE_WORK_NAME', WORK_NAME);
  if (action === 'cleanup') {
    await cleanup(workRoot, workName);
    return;
  }
  const stagingRoot = requiredPath('RESTORE_STAGING_ROOT');
  const stagingName = requiredName('RESTORE_STAGING_NAME', STAGING_NAME);
  await prepare(stagingRoot, stagingName, workRoot, workName);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore replay work preparation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
