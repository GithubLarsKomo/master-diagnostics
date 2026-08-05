import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import type { Database } from '../client';
import { tenantExportPackages } from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export interface TenantExportPackageInput {
  id: string;
  tenantId: string;
  tokenHash: string;
  storageReference: string;
  packageSha256: string;
  actor: AuditActorContext;
  expiresAt: string;
}

export async function createTenantExportPackage(
  db: Database,
  input: TenantExportPackageInput,
) {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(tenantExportPackages).values({
      id: input.id,
      tenantId: input.tenantId,
      tokenHash: input.tokenHash,
      storageReference: input.storageReference,
      packageSha256: input.packageSha256,
      createdByUserId: input.actor.userId,
      expiresAt: input.expiresAt,
      downloadedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await appendAuditEvent(tx, {
      tenantId: input.tenantId,
      occurredAt: now,
      ...auditActorFields(input.actor),
      action: 'tenant_export.created',
      entityType: 'tenant_export_package',
      entityId: input.id,
      source: 'WEB',
      after: {
        packageSha256: input.packageSha256,
        expiresAt: input.expiresAt,
      },
    });
  });
}

export async function getAvailableTenantExportPackage(
  db: Database,
  tokenHash: string,
  now = new Date().toISOString(),
) {
  const rows = await db
    .select()
    .from(tenantExportPackages)
    .where(and(
      eq(tenantExportPackages.tokenHash, tokenHash),
      isNull(tenantExportPackages.downloadedAt),
      gt(tenantExportPackages.expiresAt, now),
    ))
    .limit(1);
  return rows[0] ?? null;
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

    await appendAuditEvent(tx, {
      tenantId: row.tenantId,
      occurredAt: now,
      action: 'tenant_export.downloaded',
      entityType: 'tenant_export_package',
      entityId: row.id,
      source: 'DOWNLOAD_LINK',
      after: {
        createdByUserId: row.createdByUserId,
        packageSha256: row.packageSha256,
      },
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
