import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemDataSubjectDeliveryPackageStorage } from './data-subject-delivery-package-storage';
import { FileSystemReportArtifactStorage } from './report-artifact-storage';
import { stageAnonymizationArtifacts } from './server/anonymization-artifact-quarantine';
import { FileSystemTenantExportPackageStorage } from './tenant-export-package-storage';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('anonymization artifact quarantine', () => {
  it('stages, idempotently re-stages and restores a report artifact before DB commit', async () => {
    const storage = new FileSystemReportArtifactStorage(await tempRoot('masters-report-quarantine-'));
    const reference = 'tenant-a/test-a/de/report.pdf';
    const executionId = 'execution-12345678';
    const bytes = new TextEncoder().encode('%PDF-1.4\nprivacy-sensitive\n%%EOF');
    await storage.put(reference, bytes);

    const first = await storage.stageForDeletion(executionId, reference);
    const second = await storage.stageForDeletion(executionId, reference);
    expect(second).toEqual(first);
    await expect(storage.get(reference)).rejects.toThrow();

    await storage.restoreStaged(first);
    expect(Array.from(await storage.get(reference))).toEqual(Array.from(bytes));
    await storage.restoreStaged(first);
  });

  it('purges a staged report artifact only after the caller decides commit is durable', async () => {
    const storage = new FileSystemReportArtifactStorage(await tempRoot('masters-report-purge-'));
    const reference = 'tenant-a/test-a/en/report.pdf';
    const handle = await (async () => {
      await storage.put(reference, new TextEncoder().encode('report'));
      return storage.stageForDeletion('execution-abcdefgh', reference);
    })();

    await storage.purgeStaged(handle);
    await expect(storage.restoreStaged(handle)).rejects.toThrow(/missing/i);
    await expect(storage.get(reference)).rejects.toThrow();
  });

  it('stages and restores a complete tenant export package with the same protocol', async () => {
    const storage = new FileSystemTenantExportPackageStorage(await tempRoot('masters-export-quarantine-'));
    const reference = '01234567-89ab-cdef-0123-456789abcdef.mde';
    const executionId = 'execution-tenant-export';
    const bytes = new TextEncoder().encode('encrypted-export-package');
    await storage.put(reference, bytes);

    const handle = await storage.stageForDeletion(executionId, reference);
    await expect(storage.get(reference)).rejects.toThrow();
    expect(await storage.stageForDeletion(executionId, reference)).toEqual(handle);

    await storage.restoreStaged(handle);
    expect(Array.from(await storage.get(reference))).toEqual(Array.from(bytes));
  });

  it('stages and restores an encrypted data-subject package with the same protocol', async () => {
    const storage = new FileSystemDataSubjectDeliveryPackageStorage(await tempRoot('masters-subject-quarantine-'));
    const reference = '123e4567-e89b-12d3-a456-426614174000.mdse';
    const executionId = 'execution-subject-export';
    const bytes = new TextEncoder().encode('encrypted-subject-package');
    await storage.put(reference, bytes);

    const handle = await storage.stageForDeletion(executionId, reference);
    await expect(storage.get(reference)).rejects.toThrow();
    expect(await storage.stageForDeletion(executionId, reference)).toEqual(handle);

    await storage.restoreStaged(handle);
    expect(Array.from(await storage.get(reference))).toEqual(Array.from(bytes));
  });

  it('restores already staged artifacts if a later staging operation fails', async () => {
    const reportStorage = new FileSystemReportArtifactStorage(await tempRoot('masters-report-rollback-'));
    const exportStorage = new FileSystemTenantExportPackageStorage(await tempRoot('masters-export-rollback-'));
    const subjectStorage = new FileSystemDataSubjectDeliveryPackageStorage(await tempRoot('masters-subject-rollback-'));
    const activeReference = 'tenant/test/de/a-report.pdf';
    const missingReference = 'tenant/test/de/z-missing.pdf';
    const bytes = new TextEncoder().encode('active-report');
    await reportStorage.put(activeReference, bytes);

    await expect(stageAnonymizationArtifacts(
      'execution-rollback-1234',
      [activeReference, missingReference],
      [],
      [],
      reportStorage,
      exportStorage,
      subjectStorage,
    )).rejects.toThrow(/not found/i);

    expect(Array.from(await reportStorage.get(activeReference))).toEqual(Array.from(bytes));
  });

  it('rejects unsafe execution identifiers before constructing quarantine paths', async () => {
    const reportStorage = new FileSystemReportArtifactStorage(await tempRoot('masters-report-invalid-'));
    await reportStorage.put('tenant/test/de/report.pdf', new TextEncoder().encode('report'));
    await expect(reportStorage.stageForDeletion('../escape', 'tenant/test/de/report.pdf'))
      .rejects.toThrow(/execution id/i);

    const exportStorage = new FileSystemTenantExportPackageStorage(await tempRoot('masters-export-invalid-'));
    const exportReference = '01234567-89ab-cdef-0123-456789abcdef.mde';
    await exportStorage.put(exportReference, new TextEncoder().encode('export'));
    await expect(exportStorage.stageForDeletion('bad/id', exportReference)).rejects.toThrow(/execution id/i);

    const subjectStorage = new FileSystemDataSubjectDeliveryPackageStorage(await tempRoot('masters-subject-invalid-'));
    const subjectReference = '123e4567-e89b-12d3-a456-426614174000.mdse';
    await subjectStorage.put(subjectReference, new TextEncoder().encode('subject'));
    await expect(subjectStorage.stageForDeletion('bad/id', subjectReference)).rejects.toThrow(/execution id/i);
  });
});
