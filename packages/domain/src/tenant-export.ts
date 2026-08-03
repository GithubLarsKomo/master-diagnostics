export const TENANT_EXPORT_SCHEMA_VERSION = 'masters-tenant-export-v1' as const;

export interface TenantExportSectionManifest {
  rowCount: number;
  sha256: string;
}

export interface TenantExportReportArtifact {
  reportVersionId: string;
  storageReference: string;
  mediaType: 'application/pdf';
  sha256: string;
  base64: string;
}

export interface TenantExportManifest {
  schemaVersion: typeof TENANT_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  tenantId: string;
  sections: Record<string, TenantExportSectionManifest>;
  reportArtifacts: Array<Pick<TenantExportReportArtifact, 'reportVersionId' | 'storageReference' | 'sha256'>>;
}

export interface TenantPortabilityExportDocument {
  schemaVersion: typeof TENANT_EXPORT_SCHEMA_VERSION;
  manifest: TenantExportManifest;
  tenant: Record<string, unknown>;
  users: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  data: Record<string, Record<string, unknown>[]>;
  reportArtifacts: TenantExportReportArtifact[];
  dataDictionary: Record<string, Array<{
    name: string;
    type: string;
    notNull: boolean;
    primaryKey: boolean;
  }>>;
}
