import {
  listExpiredTenantExportPackages,
  removeTenantExportPackageRecord,
} from '@masters/db';
import { db } from '@/lib/db';
import { createTenantExportPackageStorage } from '@/lib/tenant-export-package-storage';

export async function cleanupExpiredTenantExportPackages(now = new Date().toISOString()) {
  const storage = createTenantExportPackageStorage();
  const expired = await listExpiredTenantExportPackages(db, now);
  for (const row of expired) {
    await storage.remove(row.storageReference);
    await removeTenantExportPackageRecord(db, row.id);
  }
  return expired.length;
}
