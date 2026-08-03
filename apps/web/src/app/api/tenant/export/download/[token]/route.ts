import { createHash } from 'node:crypto';
import {
  consumeTenantExportPackage,
  getAvailableTenantExportPackage,
} from '@masters/db';
import { db } from '@/lib/db';
import { cleanupExpiredTenantExportPackages } from '@/lib/tenant-export-package-lifecycle';
import { createTenantExportPackageStorage } from '@/lib/tenant-export-package-storage';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!validToken(token)) {
    return Response.json({ error: 'TENANT_EXPORT_DOWNLOAD_NOT_FOUND' }, { status: 404 });
  }

  await cleanupExpiredTenantExportPackages();

  const tokenHash = sha256(token);
  const available = await getAvailableTenantExportPackage(db, tokenHash);
  if (!available) {
    return Response.json({ error: 'TENANT_EXPORT_DOWNLOAD_NOT_FOUND' }, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const storage = createTenantExportPackageStorage();
  let bytes: Uint8Array;
  try {
    bytes = await storage.get(available.storageReference);
  } catch {
    return Response.json({ error: 'TENANT_EXPORT_PACKAGE_MISSING' }, { status: 410 });
  }

  if (sha256(bytes) !== available.packageSha256) {
    return Response.json({ error: 'TENANT_EXPORT_PACKAGE_CHECKSUM_MISMATCH' }, { status: 409 });
  }

  const claimed = await consumeTenantExportPackage(db, tokenHash);
  if (!claimed) {
    return Response.json({ error: 'TENANT_EXPORT_DOWNLOAD_NOT_FOUND' }, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  try {
    await storage.remove(claimed.storageReference);
  } catch {
    // The token is already consumed. Expiry cleanup will retry physical deletion.
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.masters-diagnostics.encrypted+json',
      'Content-Disposition': `attachment; filename="tenant-export-${claimed.id}.mde"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
