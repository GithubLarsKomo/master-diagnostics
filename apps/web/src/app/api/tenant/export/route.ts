import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import {
  TENANT_EXPORT_SCHEMA_VERSION,
  type TenantExportReportArtifact,
  type TenantPortabilityExportDocument,
} from '@masters/domain';
import { getTenantPortabilityExportSource } from '@masters/db';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { createReportArtifactStorage } from '@/lib/report-artifact-storage';
import { getTenantContext } from '@/lib/tenant-context';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function parsePassword(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const password = (value as { password?: unknown }).password;
  return typeof password === 'string' && password.length > 0 ? password : null;
}

export async function GET() {
  return Response.json(
    { error: 'TENANT_EXPORT_REAUTHENTICATION_REQUIRED' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(request: Request) {
  const context = await getTenantContext();
  if (context.role !== 'TENANT_ADMIN') {
    return Response.json({ error: 'TENANT_EXPORT_FORBIDDEN' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'TENANT_EXPORT_PASSWORD_REQUIRED' }, { status: 400 });
  }
  const password = parsePassword(body);
  if (!password) {
    return Response.json({ error: 'TENANT_EXPORT_PASSWORD_REQUIRED' }, { status: 400 });
  }

  try {
    await auth.api.verifyPassword({
      body: { password },
      headers: await headers(),
    });
  } catch {
    return Response.json({ error: 'TENANT_EXPORT_REAUTHENTICATION_FAILED' }, { status: 401 });
  }

  const source = await getTenantPortabilityExportSource(db, context.tenantId);
  if (!source) {
    return Response.json({ error: 'TENANT_EXPORT_TENANT_NOT_FOUND' }, { status: 404 });
  }

  const storage = createReportArtifactStorage();
  const reportArtifacts: TenantExportReportArtifact[] = [];
  try {
    for (const row of source.tables.report_versions) {
      const reportVersionId = String(row.id ?? '');
      const storageReference = String(row.storage_reference ?? '');
      if (!reportVersionId || !storageReference) {
        return Response.json({ error: 'TENANT_EXPORT_INVALID_REPORT_REFERENCE' }, { status: 409 });
      }
      const bytes = await storage.get(storageReference);
      reportArtifacts.push({
        reportVersionId,
        storageReference,
        mediaType: 'application/pdf',
        sha256: sha256(bytes),
        base64: Buffer.from(bytes).toString('base64'),
      });
    }
  } catch {
    return Response.json({ error: 'TENANT_EXPORT_REPORT_ARTIFACT_MISSING' }, { status: 409 });
  }

  const exportedAt = new Date().toISOString();
  const sectionValues: Record<string, unknown> = {
    tenant: source.tenant,
    users: source.users,
    tenant_memberships: source.memberships,
    ...source.tables,
  };
  const sections = Object.fromEntries(Object.entries(sectionValues).map(([name, value]) => [
    name,
    {
      rowCount: Array.isArray(value) ? value.length : 1,
      sha256: jsonHash(value),
    },
  ]));

  const document: TenantPortabilityExportDocument = {
    schemaVersion: TENANT_EXPORT_SCHEMA_VERSION,
    manifest: {
      schemaVersion: TENANT_EXPORT_SCHEMA_VERSION,
      exportedAt,
      tenantId: context.tenantId,
      sections,
      reportArtifacts: reportArtifacts.map(({ reportVersionId, storageReference, sha256: artifactSha256 }) => ({
        reportVersionId,
        storageReference,
        sha256: artifactSha256,
      })),
    },
    tenant: source.tenant,
    users: source.users,
    memberships: source.memberships,
    data: source.tables,
    reportArtifacts,
    dataDictionary: source.dataDictionary,
  };

  return Response.json(document, {
    status: 200,
    headers: {
      'Content-Disposition': `attachment; filename="tenant-${context.tenantId}-export.json"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
