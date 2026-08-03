import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import type { Database } from '../client';
import { auditEvents, tenantExportPackages } from '../schema';

export interface TenantExportPackageInput {
  id: string;
  tenantId: string;
  tokenHash: string;
  storageReference: string;
  packageSha256: string;
  createdByUserId: string;
  expiresAt: string;
}

export async function createTenantExportPackage(
  db: Database,
  input: TenantExportPackageInput,
) {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(tenantExportPackages).values({
      ...input,
      downloadedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      occurredAt: now,
      actorUserId: input.createdByUserId,
      actorRole: 'TENANT_ADMIN',
      action: 'tenant_export.created',
      entityType: 'tenant_export_package',
      entityId: input.id,
      source: 'WEB',
      afterJson: JSON.stringify({
        packageSha256: input.packageSha256,
        expiresAt: input.expiresAt,
      }),
      correlationId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function consumeTenantExportPackage(
  db: Database,
  tokenHash: string,
  now = new Date().toISOString(),
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(tenantExportPackages)
      .set({ downloadedAt: now, updatedAt: now })
      .where(and(
        eq(tenantExportPackages.tokenHash, tokenHash),
        isNull(tenantExportPackages.downloadedAt),
        gt(tenantExportPackages.expiresAt, now),
      ))
      .returning();
    const row = rows[0] ?? null;
    if (!row) return null;

    await tx.insert(auditEvents).values({
      id: crypto.randomUUID(),
      tenantId: row.tenantId,
      occurredAt: now,
      actorUserId: row.createdByUserId,
      actorRole: 'TENANT_ADMIN',
      action: 'tenant_export.downloaded',
      entityType: 'tenant_export_package',
      entityId: row.id,
      source: 'DOWNLOAD_LINK',
      correlationId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    return row;
  });
}

export async function listExpiredTenantExportPackages(
  db: Database,
  now = new Date().toISOString(),
) {
  return db
    .select()
    .from(tenantExportPackages)
    .where(lte(tenantExportPackages.expiresAt, now));
}

export async function removeTenantExportPackageRecord(db: Database, id: string) {
  await db.delete(tenantExportPackages).where(eq(tenantExportPackages.id, id));
}
