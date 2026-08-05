import { access, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ReportArtifactStorage {
  put(reference: string, bytes: Uint8Array): Promise<void>;
  get(reference: string): Promise<Uint8Array>;
  remove(reference: string): Promise<void>;
}

export interface StagedReportArtifact {
  executionId: string;
  reference: string;
}

export interface QuarantinableReportArtifactStorage extends ReportArtifactStorage {
  stageForDeletion(executionId: string, reference: string): Promise<Readonly<StagedReportArtifact>>;
  restoreStaged(handle: Readonly<StagedReportArtifact>): Promise<void>;
  purgeStaged(handle: Readonly<StagedReportArtifact>): Promise<void>;
}

function assertSafeReference(reference: string): void {
  if (!/^[a-zA-Z0-9/_-]+\.pdf$/.test(reference) || reference.startsWith('/') || reference.includes('..')) {
    throw new Error('Invalid report storage reference');
  }
}

function assertSafeExecutionId(executionId: string): void {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(executionId)) {
    throw new Error('Invalid anonymization execution id');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class FileSystemReportArtifactStorage implements QuarantinableReportArtifactStorage {
  constructor(private readonly rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('Report storage root directory is required');
  }

  private path(reference: string): string {
    assertSafeReference(reference);
    return join(this.rootDirectory, reference);
  }

  private quarantinePath(executionId: string, reference: string): string {
    assertSafeExecutionId(executionId);
    assertSafeReference(reference);
    return join(this.rootDirectory, '.anonymization-quarantine', executionId, reference);
  }

  async put(reference: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(reference);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      // Hard-link creation is atomic and fails when the immutable target already exists.
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(reference: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(reference)));
  }

  async remove(reference: string): Promise<void> {
    await rm(this.path(reference), { force: true });
  }

  async stageForDeletion(
    executionId: string,
    reference: string,
  ): Promise<Readonly<StagedReportArtifact>> {
    const original = this.path(reference);
    const staged = this.quarantinePath(executionId, reference);
    const [originalExists, stagedExists] = await Promise.all([exists(original), exists(staged)]);

    if (stagedExists) {
      if (originalExists) throw new Error('Report artifact exists in both active and quarantine storage');
      return Object.freeze({ executionId, reference });
    }
    if (!originalExists) throw new Error('Report artifact not found for anonymization staging');

    await mkdir(dirname(staged), { recursive: true });
    await rename(original, staged);
    return Object.freeze({ executionId, reference });
  }

  async restoreStaged(handle: Readonly<StagedReportArtifact>): Promise<void> {
    const original = this.path(handle.reference);
    const staged = this.quarantinePath(handle.executionId, handle.reference);
    const [originalExists, stagedExists] = await Promise.all([exists(original), exists(staged)]);

    if (!stagedExists) {
      if (originalExists) return;
      throw new Error('Staged report artifact is missing and cannot be restored');
    }
    if (originalExists) throw new Error('Cannot restore report artifact over an active file');

    await mkdir(dirname(original), { recursive: true });
    await rename(staged, original);
  }

  async purgeStaged(handle: Readonly<StagedReportArtifact>): Promise<void> {
    await rm(this.quarantinePath(handle.executionId, handle.reference), { force: true });
  }
}

export function createReportArtifactStorage(): QuarantinableReportArtifactStorage {
  return new FileSystemReportArtifactStorage(process.env.REPORT_STORAGE_DIR ?? '/var/lib/masters/reports');
}
