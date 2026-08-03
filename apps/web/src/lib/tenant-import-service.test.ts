import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTenantImportPlan } from '@masters/db';
import type { TenantPortabilityExportDocument } from '@masters/domain';
import type { ReportArtifactStorage } from './report-artifact-storage';
import {
  prepareTenantImportReportArtifacts,
  rollbackPreparedTenantImportReportArtifacts,
} from './tenant-import-service';

class MemoryReportStorage implements ReportArtifactStorage {
  readonly values = new Map<string, Uint8Array>();

  async put(reference: string, bytes: Uint8Array): Promise<void> {
    if (this.values.has(reference)) throw new Error('immutable target exists');
    this.values.set(reference, Uint8Array.from(bytes));
  }

  async get(reference: string): Promise<Uint8Array> {
    const value = this.values.get(reference);
    if (!value) throw new Error('missing');
    return Uint8Array.from(value);
  }

  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

function fixture() {
  const bytes = new TextEncoder().encode('%PDF-1.4\nimported\n%%EOF');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const document: TenantPortabilityExportDocument = {
    schemaVersion: 'masters-tenant-export-v1',
    manifest: {
      schemaVersion: 'masters-tenant-export-v1',
      exportedAt: '2026-08-03T10:00:00.000Z',
      tenantId: 'tenant-source',
      sections: {},
      reportArtifacts: [],
    },
    tenant: { id: 'tenant-source', slug: 'source', name: 'Source' },
    users: [],
    memberships: [],
    data: {
      tests: [{ id: 'test-source', tenant_id: 'tenant-source' }],
      report_versions: [{
        id: 'report-source', tenant_id: 'tenant-source', test_id: 'test-source', interpretation_id: 'interpretation-source',
        version_number: 1, locale: 'de', content_hash: `sha256:${digest}`, storage_reference: 'old/report.pdf',
      }],
      interpretations: [{ id: 'interpretation-source', tenant_id: 'tenant-source', test_id: 'test-source' }],
    } as TenantPortabilityExportDocument['data'],
    reportArtifacts: [{
      reportVersionId: 'report-source', storageReference: 'old/report.pdf', mediaType: 'application/pdf',
      sha256: digest, base64: Buffer.from(bytes).toString('base64'),
    }],
    dataDictionary: {},
  };
  const plan = buildTenantImportPlan(document, 'tenant-target');
  const targetTestId = plan.idMap['test-source']!;
  return { bytes, digest, document, plan, targetTestId };
}

describe('tenant import report artifact compensation', () => {
  it('rewrites report storage references and removes newly prepared files on rollback', async () => {
    const { document, plan, targetTestId } = fixture();
    const storage = new MemoryReportStorage();

    const prepared = await prepareTenantImportReportArtifacts(plan, document, storage);
    const expectedReference = `tenant-target/${targetTestId}/de/${document.reportArtifacts[0]!.sha256}.pdf`;
    expect(prepared).toEqual([{ reference: expectedReference, created: true }]);
    expect(plan.tables.report_versions[0]?.storage_reference).toBe(expectedReference);
    expect(storage.values.has(expectedReference)).toBe(true);

    await rollbackPreparedTenantImportReportArtifacts(prepared, storage);
    expect(storage.values.has(expectedReference)).toBe(false);
  });

  it('does not delete an identical pre-existing immutable artifact during compensation', async () => {
    const { bytes, document, plan, targetTestId } = fixture();
    const storage = new MemoryReportStorage();
    const expectedReference = `tenant-target/${targetTestId}/de/${document.reportArtifacts[0]!.sha256}.pdf`;
    storage.values.set(expectedReference, Uint8Array.from(bytes));

    const prepared = await prepareTenantImportReportArtifacts(plan, document, storage);
    expect(prepared).toEqual([{ reference: expectedReference, created: false }]);
    await rollbackPreparedTenantImportReportArtifacts(prepared, storage);
    expect(storage.values.has(expectedReference)).toBe(true);
  });

  it('rejects report bytes that do not match the immutable content hash', async () => {
    const { document, plan } = fixture();
    const storage = new MemoryReportStorage();
    document.reportArtifacts[0]!.base64 = Buffer.from('tampered').toString('base64');

    await expect(prepareTenantImportReportArtifacts(plan, document, storage)).rejects.toThrow(/checksum mismatch/);
    expect(storage.values.size).toBe(0);
  });
});
