import { createHash } from 'node:crypto';
import {
  TENANT_EXPORT_SCHEMA_VERSION,
  type TenantExportReportArtifact,
  type TenantPortabilityExportDocument,
} from '@masters/domain';

export interface TenantImportDryRunIssue {
  code: string;
  path: string;
  message: string;
}

export interface TenantImportDryRunPreview {
  valid: boolean;
  sourceTenantId: string | null;
  sourceExportedAt: string | null;
  sections: Record<string, number>;
  reportArtifacts: number;
  totalRows: number;
  issues: TenantImportDryRunIssue[];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(code: string, path: string, message: string): TenantImportDryRunIssue {
  return { code, path, message };
}

function parseDocument(value: unknown, issues: TenantImportDryRunIssue[]): TenantPortabilityExportDocument | null {
  if (!isRecord(value)) {
    issues.push(issue('INVALID_DOCUMENT', '$', 'Export document must be an object.'));
    return null;
  }
  if (value.schemaVersion !== TENANT_EXPORT_SCHEMA_VERSION) {
    issues.push(issue('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion', `Expected ${TENANT_EXPORT_SCHEMA_VERSION}.`));
  }
  if (!isRecord(value.manifest)) issues.push(issue('INVALID_MANIFEST', '$.manifest', 'Manifest must be an object.'));
  if (!isRecord(value.tenant)) issues.push(issue('INVALID_TENANT', '$.tenant', 'Tenant must be an object.'));
  if (!Array.isArray(value.users)) issues.push(issue('INVALID_USERS', '$.users', 'Users must be an array.'));
  if (!Array.isArray(value.memberships)) issues.push(issue('INVALID_MEMBERSHIPS', '$.memberships', 'Memberships must be an array.'));
  if (!isRecord(value.data)) issues.push(issue('INVALID_DATA', '$.data', 'Data sections must be an object.'));
  if (!Array.isArray(value.reportArtifacts)) issues.push(issue('INVALID_REPORT_ARTIFACTS', '$.reportArtifacts', 'Report artifacts must be an array.'));
  if (!isRecord(value.dataDictionary)) issues.push(issue('INVALID_DATA_DICTIONARY', '$.dataDictionary', 'Data dictionary must be an object.'));
  return issues.length === 0 ? value as unknown as TenantPortabilityExportDocument : null;
}

function verifyReportArtifact(artifact: TenantExportReportArtifact, index: number, issues: TenantImportDryRunIssue[]) {
  const path = `$.reportArtifacts[${index}]`;
  if (artifact.mediaType !== 'application/pdf') {
    issues.push(issue('UNSUPPORTED_REPORT_MEDIA_TYPE', `${path}.mediaType`, 'Only PDF report artifacts are supported.'));
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(artifact.base64, 'base64');
  } catch {
    issues.push(issue('INVALID_REPORT_BASE64', `${path}.base64`, 'Report artifact is not valid base64.'));
    return;
  }
  if (sha256(bytes) !== artifact.sha256) {
    issues.push(issue('REPORT_CHECKSUM_MISMATCH', `${path}.sha256`, 'Report artifact checksum does not match.'));
  }
}

export function validateTenantImportDryRun(value: unknown): TenantImportDryRunPreview {
  const issues: TenantImportDryRunIssue[] = [];
  const document = parseDocument(value, issues);
  if (!document) {
    return { valid: false, sourceTenantId: null, sourceExportedAt: null, sections: {}, reportArtifacts: 0, totalRows: 0, issues };
  }

  const manifest = document.manifest;
  if (manifest.schemaVersion !== TENANT_EXPORT_SCHEMA_VERSION) {
    issues.push(issue('MANIFEST_SCHEMA_VERSION_MISMATCH', '$.manifest.schemaVersion', 'Manifest schema version does not match.'));
  }
  const tenantId = typeof document.tenant.id === 'string' ? document.tenant.id : null;
  if (!tenantId || tenantId !== manifest.tenantId) {
    issues.push(issue('TENANT_ID_MISMATCH', '$.manifest.tenantId', 'Manifest tenant ID must match tenant.id.'));
  }

  const sectionValues: Record<string, unknown> = {
    tenant: document.tenant,
    users: document.users,
    tenant_memberships: document.memberships,
    ...document.data,
  };
  const sectionCounts: Record<string, number> = {};
  for (const [name, entry] of Object.entries(manifest.sections)) {
    const path = `$.manifest.sections.${name}`;
    if (!(name in sectionValues)) {
      issues.push(issue('UNKNOWN_MANIFEST_SECTION', path, 'Manifest references a missing data section.'));
      continue;
    }
    const valueForSection = sectionValues[name];
    const rowCount = Array.isArray(valueForSection) ? valueForSection.length : 1;
    sectionCounts[name] = rowCount;
    if (entry.rowCount !== rowCount) {
      issues.push(issue('SECTION_ROW_COUNT_MISMATCH', `${path}.rowCount`, `Expected ${rowCount} row(s).`));
    }
    if (entry.sha256 !== sha256(JSON.stringify(valueForSection))) {
      issues.push(issue('SECTION_CHECKSUM_MISMATCH', `${path}.sha256`, 'Section checksum does not match.'));
    }
  }
  for (const name of Object.keys(sectionValues)) {
    if (!(name in manifest.sections)) {
      issues.push(issue('MISSING_MANIFEST_SECTION', `$.manifest.sections.${name}`, 'Data section has no manifest entry.'));
      sectionCounts[name] = Array.isArray(sectionValues[name]) ? (sectionValues[name] as unknown[]).length : 1;
    }
  }

  document.reportArtifacts.forEach((artifact, index) => verifyReportArtifact(artifact, index, issues));
  const artifactManifestById = new Map(manifest.reportArtifacts.map((entry) => [entry.reportVersionId, entry]));
  for (const [index, artifact] of document.reportArtifacts.entries()) {
    const manifestEntry = artifactManifestById.get(artifact.reportVersionId);
    if (!manifestEntry) {
      issues.push(issue('MISSING_REPORT_MANIFEST_ENTRY', `$.reportArtifacts[${index}]`, 'Report artifact has no manifest entry.'));
    } else if (manifestEntry.sha256 !== artifact.sha256 || manifestEntry.storageReference !== artifact.storageReference) {
      issues.push(issue('REPORT_MANIFEST_MISMATCH', `$.reportArtifacts[${index}]`, 'Report artifact metadata does not match the manifest.'));
    }
  }
  if (manifest.reportArtifacts.length !== document.reportArtifacts.length) {
    issues.push(issue('REPORT_ARTIFACT_COUNT_MISMATCH', '$.manifest.reportArtifacts', 'Report artifact count does not match.'));
  }

  const totalRows = Object.values(sectionCounts).reduce((sum, count) => sum + count, 0);
  return {
    valid: issues.length === 0,
    sourceTenantId: tenantId,
    sourceExportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : null,
    sections: sectionCounts,
    reportArtifacts: document.reportArtifacts.length,
    totalRows,
    issues,
  };
}
