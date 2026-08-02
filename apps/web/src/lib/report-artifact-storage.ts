import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ReportArtifactStorage {
  put(reference: string, bytes: Uint8Array): Promise<void>;
  get(reference: string): Promise<Uint8Array>;
  remove(reference: string): Promise<void>;
}

function assertSafeReference(reference: string): void {
  if (!/^[a-zA-Z0-9/_-]+\.pdf$/.test(reference) || reference.startsWith('/') || reference.includes('..')) {
    throw new Error('Invalid report storage reference');
  }
}

export class FileSystemReportArtifactStorage implements ReportArtifactStorage {
  constructor(private readonly rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('Report storage root directory is required');
  }

  private path(reference: string): string {
    assertSafeReference(reference);
    return join(this.rootDirectory, reference);
  }

  async put(reference: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(reference);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }

  async get(reference: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(reference)));
  }

  async remove(reference: string): Promise<void> {
    await rm(this.path(reference), { force: true });
  }
}

export function createReportArtifactStorage(): ReportArtifactStorage {
  return new FileSystemReportArtifactStorage(process.env.REPORT_STORAGE_DIR ?? '/var/lib/masters/reports');
}
