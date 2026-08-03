import type { EncryptedTenantExportPackage } from '@/lib/tenant-export-encryption';
import { decryptTenantExport } from '@/lib/tenant-export-encryption';
import { validateTenantImportDryRun } from '@/lib/tenant-import-dry-run';
import { getTenantContext } from '@/lib/tenant-context';

interface DryRunRequestBody {
  package?: unknown;
  decryptionKey?: unknown;
}

function parseEncryptedPackage(value: unknown): EncryptedTenantExportPackage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 'masters-tenant-export-encrypted-v1' ||
    candidate.algorithm !== 'AES-256-GCM' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.authTag !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) return null;
  return candidate as unknown as EncryptedTenantExportPackage;
}

export async function POST(request: Request) {
  const context = await getTenantContext();
  if (context.role !== 'TENANT_ADMIN') {
    return Response.json({ error: 'TENANT_IMPORT_FORBIDDEN' }, { status: 403 });
  }

  let body: DryRunRequestBody;
  try {
    body = await request.json() as DryRunRequestBody;
  } catch {
    return Response.json({ error: 'TENANT_IMPORT_INVALID_REQUEST' }, { status: 400 });
  }

  const encryptedPackage = parseEncryptedPackage(body.package);
  const decryptionKey = typeof body.decryptionKey === 'string' ? body.decryptionKey : null;
  if (!encryptedPackage || !decryptionKey) {
    return Response.json({ error: 'TENANT_IMPORT_ENCRYPTED_PACKAGE_REQUIRED' }, { status: 400 });
  }

  let plaintext: Uint8Array;
  try {
    plaintext = decryptTenantExport(encryptedPackage, decryptionKey);
  } catch {
    return Response.json({ error: 'TENANT_IMPORT_DECRYPTION_FAILED' }, { status: 400 });
  }

  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    return Response.json({ error: 'TENANT_IMPORT_INVALID_JSON' }, { status: 400 });
  }

  const preview = validateTenantImportDryRun(document);
  return Response.json(preview, {
    status: preview.valid ? 200 : 422,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
