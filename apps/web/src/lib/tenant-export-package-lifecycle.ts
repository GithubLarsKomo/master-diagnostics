import {
  listExpiredTenantExportPackages,
  removeTenantExportPackageRecord,
  tenantHasActiveAnonymizationExecution,
  type Database,
} from '@masters/db';
import { db } from './db';
import {
  createTenantExportPackageStorage,
  type TenantExportPackageStorage,
} from './tenant-export-package-storage';

export async function cleanupExpiredTenantExportPackagesWithDependencies(
  database: Database,
  storage: TenantExportPackageStorage,
  now = new Date().toISOString(),
) {
  const expired = await listExpiredTenantExportPackages(database, now);
  let removed = 0;
  for (const row of expired) {
    // A PREPARING/ARTIFACTS_STAGED execution owns a durable manifest that must
    // remain consistent until either rollback or DB commit. Deleting a package
    // row here could otherwise restore a quarantined file without its DB record.
    if (await tenantHasActiveAnonymizationExecution(database, row.tenantId)) continue;
    await storage.remove(row.storageReference);
    await removeTenantExportPackageRecord(database, row.id);
    removed += 1;
  }
  return removed;
}

export async function cleanupExpiredTenantExportPackages(now = new Date().toISOString()) {
  return cleanupExpiredTenantExportPackagesWithDependencies(
    db,
    createTenantExportPackageStorage(),
    now,
  );
}
