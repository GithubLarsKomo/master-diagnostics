import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateTenantImportDryRun } from './tenant-import-dry-run';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(schemaVersion = 'masters-tenant-export-v2') {
  const tenant = { id: 'tenant-source', name: 'Source Club' };
  const users = [{ id: 'user-1', display_name: 'Admin' }];
  const memberships = [{ id: 'membership-1', tenant_id: 'tenant-source', user_id: 'user-1' }];
  const athletes = [{ id: 'athlete-1', tenant_id: 'tenant-source', first_name: 'Max' }];
  const reportBytes = Buffer.from('%PDF-test', 'utf8');
  const reportSha = sha256(reportBytes);
  const sectionValues = {
    tenant,
    users,
    tenant_memberships: memberships,
    athletes,
  };
  const sections = Object.fromEntries(Object.entries(sectionValues).map(([name, value]) => [name, {
    rowCount: Array.isArray(value) ? value.length : 1,
    sha256: sha256(JSON.stringify(value)),
  }]));

  return {
    schemaVersion,
    manifest: {
      schemaVersion,
      exportedAt: '2026-08-03T08:00:00.000Z',
      tenantId: 'tenant-source',
      sections,
      reportArtifacts: [{ reportVersionId: 'report-1', storageReference: 'reports/report-1.pdf', sha256: reportSha }],
    },
    tenant,
    users,
    memberships,
    data: { athletes },
    reportArtifacts: [{
      reportVersionId: 'report-1',
      storageReference: 'reports/report-1.pdf',
      mediaType: 'application/pdf',
      sha256: reportSha,
      base64: reportBytes.toString('base64'),
    }],
    dataDictionary: { athletes: [{ name: 'id', type: 'text', notNull: true, primaryKey: true }] },
  };
}

describe('tenant import dry-run', () => {
  it('accepts the current v2 export contract and returns a write-free preview', () => {
    const preview = validateTenantImportDryRun(fixture());
    expect(preview.valid).toBe(true);
    expect(preview.sourceTenantId).toBe('tenant-source');
    expect(preview.sections).toEqual({ tenant: 1, users: 1, tenant_memberships: 1, athletes: 1 });
    expect(preview.reportArtifacts).toBe(1);
    expect(preview.totalRows).toBe(4);
    expect(preview.issues).toEqual([]);
  });

  it('keeps legacy v1 exports importable', () => {
    const preview = validateTenantImportDryRun(fixture('masters-tenant-export-v1'));
    expect(preview.valid).toBe(true);
    expect(preview.issues).toEqual([]);
  });

  it('rejects an unknown version and a document/manifest version mismatch', () => {
    const unsupported = fixture('masters-tenant-export-v3');
    expect(validateTenantImportDryRun(unsupported).issues.map((entry) => entry.code))
      .toContain('UNSUPPORTED_SCHEMA_VERSION');

    const mismatch = fixture();
    mismatch.manifest.schemaVersion = 'masters-tenant-export-v1';
    expect(validateTenantImportDryRun(mismatch).issues.map((entry) => entry.code))
      .toContain('MANIFEST_SCHEMA_VERSION_MISMATCH');
  });

  it('detects tampered section content and row counts', () => {
    const document = fixture();
    document.data.athletes.push({ id: 'athlete-2', tenant_id: 'tenant-source', first_name: 'Tampered' });
    const preview = validateTenantImportDryRun(document);
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((entry) => entry.code)).toContain('SECTION_ROW_COUNT_MISMATCH');
    expect(preview.issues.map((entry) => entry.code)).toContain('SECTION_CHECKSUM_MISMATCH');
  });

  it('detects report and tenant identity tampering', () => {
    const document = fixture();
    document.manifest.tenantId = 'other-tenant';
    document.reportArtifacts[0]!.base64 = Buffer.from('tampered', 'utf8').toString('base64');
    const preview = validateTenantImportDryRun(document);
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((entry) => entry.code)).toContain('TENANT_ID_MISMATCH');
    expect(preview.issues.map((entry) => entry.code)).toContain('REPORT_CHECKSUM_MISMATCH');
  });

  it('fails closed on a structurally incomplete manifest instead of throwing', () => {
    const document = fixture() as unknown as Record<string, unknown>;
    document.manifest = { schemaVersion: 'masters-tenant-export-v2' };
    const preview = validateTenantImportDryRun(document);
    expect(preview.valid).toBe(false);
    expect(preview.sourceTenantId).toBeNull();
    expect(preview.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'INVALID_MANIFEST_SECTIONS',
      'INVALID_MANIFEST_REPORT_ARTIFACTS',
      'INVALID_MANIFEST_TENANT_ID',
      'INVALID_MANIFEST_EXPORTED_AT',
    ]));
  });

  it('rejects malformed report base64 without throwing', () => {
    const document = fixture();
    document.reportArtifacts[0]!.base64 = '***not-base64***';
    const preview = validateTenantImportDryRun(document);
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((entry) => entry.code)).toContain('INVALID_REPORT_BASE64');
  });
});
