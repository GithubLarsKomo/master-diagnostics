import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TenantExportPackageStorage {
  put(reference: string, bytes: Uint8Array): Promise<void>;
  get(reference: string): Promise<Uint8Array>;
  remove(reference: string): Promise<void>;
}

export interface StagedTenantExportPackage {
  executionId: string;
  reference: string;
}

export interface QuarantinableTenantExportPackageStorage extends TenantExportPackageStorage {
  stageForDeletion(executionId: string, reference: string): Promise<Readonly<StagedTenantExportPackage>>;
  restoreStaged(handle: Readonly<StagedTenantExportPackage>): Promise<void>;
  purgeStaged(handle: Readonly<StagedTenantExportPackage>): Promise<void>;
}

function assertSafeReference(reference: string): void {
  if (!/^[a-f0-9-]+\.mde$/.test(reference) || reference.includes('..') || reference.startsWith('/')) {
    throw new Error('Invalid tenant export package reference');
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

export class FileSystemTenantExportPackageStorage implements QuarantinableTenantExportPackageStorage {
  constructor(private readonly rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('Tenant export package root directory is required');
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
    await mkdir(this.rootDirectory, { recursive: true });
    await writeFile(this.path(reference), bytes, { flag: 'wx', mode: 0o600 });
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
  ): Promise<Readonly<StagedTenantExportPackage>> {
    const original = this.path(reference);
    const staged = this.quarantinePath(executionId, reference);
    const [originalExists, stagedExists] = await Promise.all([exists(original), exists(staged)]);

    if (stagedExists) {
      if (originalExists) throw new Error('Tenant export exists in both active and quarantine storage');
      return Object.freeze({ executionId, reference });
    }
    if (!originalExists) throw new Error('Tenant export package not found for anonymization staging');

    await mkdir(join(this.rootDirectory, '.anonymization-quarantine', executionId), { recursive: true });
    await rename(original, staged);
    return Object.freeze({ executionId, reference });
  }

  async restoreStaged(handle: Readonly<StagedTenantExportPackage>): Promise<void> {
    const original = this.path(handle.reference);
    const staged = this.quarantinePath(handle.executionId, handle.reference);
    const [originalExists, stagedExists] = await Promise.all([exists(original), exists(staged)]);

    if (!stagedExists) {
      if (originalExists) return;
      throw new Error('Staged tenant export package is missing and cannot be restored');
    }
    if (originalExists) throw new Error('Cannot restore tenant export package over an active file');

    await mkdir(this.rootDirectory, { recursive: true });
    await rename(staged, original);
  }

  async purgeStaged(handle: Readonly<StagedTenantExportPackage>): Promise<void> {
    await rm(this.quarantinePath(handle.executionId, handle.reference), { force: true });
  }
}

export function createTenantExportPackageStorage(): QuarantinableTenantExportPackageStorage {
  return new FileSystemTenantExportPackageStorage(
    process.env.TENANT_EXPORT_STORAGE_DIR ?? '/var/lib/masters/exports',
  );
}
