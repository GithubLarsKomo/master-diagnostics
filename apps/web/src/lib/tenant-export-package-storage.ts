import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TenantExportPackageStorage {
  put(reference: string, bytes: Uint8Array): Promise<void>;
  get(reference: string): Promise<Uint8Array>;
  remove(reference: string): Promise<void>;
}

function assertSafeReference(reference: string): void {
  if (!/^[a-f0-9-]+\.mde$/.test(reference) || reference.includes('..') || reference.startsWith('/')) {
    throw new Error('Invalid tenant export package reference');
  }
}

export class FileSystemTenantExportPackageStorage implements TenantExportPackageStorage {
  constructor(private readonly rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('Tenant export package root directory is required');
  }

  private path(reference: string): string {
    assertSafeReference(reference);
    return join(this.rootDirectory, reference);
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
}

export function createTenantExportPackageStorage(): TenantExportPackageStorage {
  return new FileSystemTenantExportPackageStorage(
    process.env.TENANT_EXPORT_STORAGE_DIR ?? '/var/lib/masters/exports',
  );
}
