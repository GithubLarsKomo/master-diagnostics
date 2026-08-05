import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface DataSubjectDeliveryPackageStorage {
  put(reference: string, bytes: Uint8Array): Promise<void>;
  get(reference: string): Promise<Uint8Array>;
  remove(reference: string): Promise<void>;
}

const SAFE_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;

function safeReference(reference: string): string {
  if (!SAFE_REFERENCE.test(reference)) throw new Error('Invalid data subject delivery package reference');
  return reference;
}

export class FileSystemDataSubjectDeliveryPackageStorage implements DataSubjectDeliveryPackageStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(reference: string): string {
    return join(this.root, safeReference(reference));
  }

  async put(reference: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(reference);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(reference: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(reference)));
  }

  async remove(reference: string): Promise<void> {
    await rm(this.path(reference), { force: true });
  }
}

export function createDataSubjectDeliveryPackageStorage(): DataSubjectDeliveryPackageStorage {
  return new FileSystemDataSubjectDeliveryPackageStorage(
    process.env.DATA_SUBJECT_DELIVERY_PACKAGE_ROOT ?? '.data/data-subject-delivery-packages',
  );
}
