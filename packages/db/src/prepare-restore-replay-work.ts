import { isAbsolute } from 'node:path';
import {
  cleanupRestoreReplayWork,
  prepareRestoreReplayWork,
  RESTORE_STAGING_NAME_PATTERN,
  RESTORE_WORK_NAME_PATTERN,
} from './services/restore-replay-work';

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

async function main(): Promise<void> {
  const action = requiredAction();
  const workRoot = requiredPath('RESTORE_WORK_ROOT');
  const workName = requiredName('RESTORE_WORK_NAME', RESTORE_WORK_NAME_PATTERN);
  if (action === 'cleanup') {
    await cleanupRestoreReplayWork(workRoot, workName);
    process.stdout.write(`${JSON.stringify({ action, workName })}\n`);
    return;
  }
  const stagingRoot = requiredPath('RESTORE_STAGING_ROOT');
  const stagingName = requiredName('RESTORE_STAGING_NAME', RESTORE_STAGING_NAME_PATTERN);
  await prepareRestoreReplayWork({ stagingRoot, stagingName, workRoot, workName });
  process.stdout.write(`${JSON.stringify({ action, workName })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Restore replay work preparation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
