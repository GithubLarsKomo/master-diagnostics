import {
  listExpiredTenantExportPackages,
  removeTenantExportPackageRecord,
  tenantHasActiveAnonymizationExecution,
} from '@masters/db';
import { db } from '@/lib/db';
import { createTenantExportPackageStorage } from '@/lib/tenant-export-package-storage';

export async function cleanupExpiredTenantExportPackages(now = new Date().toISOString()) {
  const storage = createTenantExportPackageStorage();
  const expired = await listExpiredTenantExportPackages(db, now);
  let removed = 0;
  for (const row of expired) {
    // A PREPARING/ARTIFACTS_STAGED execution owns a durable manifest that must
    // remain consistent until either rollback or DB commit. Deleting a package
    // row here could otherwise restore a quarantined file without its DB record.
    if (await tenantHasActiveAnonymizationExecution(db, row.tenantId)) continue;
    await storage.remove(row.storageReference);
    await removeTenantExportPackageRecord(db, row.id);
    removed += 1;
  }
  return removed;
}
