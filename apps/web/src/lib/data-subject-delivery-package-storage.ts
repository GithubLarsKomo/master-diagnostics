import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface DataSubjectDeliveryPackageStorage {
  put(reference: string, bytes: Uint8Array): Promise<void>;
  get(reference: string): Promise<Uint8Array>;
  remove(reference: string): Promise<void>;
}

export interface StagedDataSubjectDeliveryPackage {
  executionId: string;
  reference: string;
}

export interface QuarantinableDataSubjectDeliveryPackageStorage extends DataSubjectDeliveryPackageStorage {
  stageForDeletion(
    executionId: string,
    reference: string,
  ): Promise<Readonly<StagedDataSubjectDeliveryPackage>>;
  restoreStaged(handle: Readonly<StagedDataSubjectDeliveryPackage>): Promise<void>;
  purgeStaged(handle: Readonly<StagedDataSubjectDeliveryPackage>): Promise<void>;
}

const SAFE_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;

function safeReference(reference: string): string {
  if (!SAFE_REFERENCE.test(reference)) throw new Error('Invalid data subject delivery package reference');
  return reference;
}

function safeExecutionId(executionId: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(executionId)) {
    throw new Error('Invalid anonymization execution id');
  }
  return executionId;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class FileSystemDataSubjectDeliveryPackageStorage
implements QuarantinableDataSubjectDeliveryPackageStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(reference: string): string {
    return join(this.root, safeReference(reference));
  }

  private quarantinePath(executionId: string, reference: string): string {
    return join(
      this.root,
      '.anonymization-quarantine',
      safeExecutionId(executionId),
      safeReference(reference),
    );
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

  async stageForDeletion(
    executionId: string,
    reference: string,
  ): Promise<Readonly<StagedDataSubjectDeliveryPackage>> {
    const original = this.path(reference);
    const staged = this.quarantinePath(executionId, reference);
    const [originalExists, stagedExists] = await Promise.all([exists(original), exists(staged)]);

    if (stagedExists) {
      if (originalExists) throw new Error('Data subject package exists in both active and quarantine storage');
      return Object.freeze({ executionId, reference });
    }
    if (!originalExists) throw new Error('Data subject delivery package not found for anonymization staging');

    await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
    await rename(original, staged);
    return Object.freeze({ executionId, reference });
  }

  async restoreStaged(handle: Readonly<StagedDataSubjectDeliveryPackage>): Promise<void> {
    const original = this.path(handle.reference);
    const staged = this.quarantinePath(handle.executionId, handle.reference);
    const [originalExists, stagedExists] = await Promise.all([exists(original), exists(staged)]);

    if (!stagedExists) {
      if (originalExists) return;
      throw new Error('Staged data subject delivery package is missing and cannot be restored');
    }
    if (originalExists) throw new Error('Cannot restore data subject delivery package over an active file');

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await rename(staged, original);
  }

  async purgeStaged(handle: Readonly<StagedDataSubjectDeliveryPackage>): Promise<void> {
    await rm(this.quarantinePath(handle.executionId, handle.reference), { force: true });
  }
}

export function createDataSubjectDeliveryPackageStorage(): QuarantinableDataSubjectDeliveryPackageStorage {
  return new FileSystemDataSubjectDeliveryPackageStorage(
    process.env.DATA_SUBJECT_DELIVERY_PACKAGE_ROOT ?? '.data/data-subject-delivery-packages',
  );
}
