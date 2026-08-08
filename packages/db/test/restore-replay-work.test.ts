import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupRestoreReplayWork,
  prepareRestoreReplayWork,
} from '../src/services/restore-replay-work';

const stagingName = 'restore-20260808T070000Z-11111111-1111-1111-1111-111111111111';
const workName = 'restore-work-22222222-2222-2222-2222-222222222222';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'masters-restore-work-'));
  const stagingRoot = join(root, 'staging');
  const workRoot = join(root, 'work');
  const source = join(stagingRoot, stagingName, 'libsql');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'data.sqld'), 'original');
  return { stagingRoot, workRoot, source };
}

describe('restore replay work copy', () => {
  it('copies staged libSQL into a private disposable work scope without modifying source', async () => {
    const { stagingRoot, workRoot, source } = await fixture();
    const workPath = await prepareRestoreReplayWork({ stagingRoot, stagingName, workRoot, workName });

    expect(await readFile(join(workPath, 'libsql', 'data.sqld'), 'utf8')).toBe('original');
    await writeFile(join(workPath, 'libsql', 'data.sqld'), 'work-copy');
    expect(await readFile(join(source, 'data.sqld'), 'utf8')).toBe('original');
    expect((await stat(workPath)).mode & 0o777).toBe(0o700);

    await cleanupRestoreReplayWork(workRoot, workName);
    await expect(stat(workPath)).rejects.toThrow();
    expect(await readFile(join(source, 'data.sqld'), 'utf8')).toBe('original');
  });

  it('fails closed when a work scope already exists instead of overwriting it', async () => {
    const { stagingRoot, workRoot } = await fixture();
    await prepareRestoreReplayWork({ stagingRoot, stagingName, workRoot, workName });
    await expect(prepareRestoreReplayWork({ stagingRoot, stagingName, workRoot, workName }))
      .rejects.toThrow(/already exists/i);
  });

  it('rejects unscoped names for preparation and cleanup', async () => {
    const { stagingRoot, workRoot } = await fixture();
    await expect(prepareRestoreReplayWork({
      stagingRoot,
      stagingName: '../production',
      workRoot,
      workName,
    })).rejects.toThrow(/staging name is invalid/i);
    await expect(cleanupRestoreReplayWork(workRoot, '../production')).rejects.toThrow(/work name is invalid/i);
  });
});
