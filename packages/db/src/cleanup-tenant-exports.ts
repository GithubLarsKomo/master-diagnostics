import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from './client';
import {
  listExpiredTenantExportPackages,
  removeTenantExportPackageRecord,
} from './services/tenant-export-packages';

const rootDirectory = process.env.TENANT_EXPORT_STORAGE_DIR ?? '/var/lib/masters/exports';
const db = createDatabase();
const expired = await listExpiredTenantExportPackages(db);

for (const row of expired) {
  if (!/^[a-f0-9-]+\.mde$/.test(row.storageReference)) {
    throw new Error(`Unsafe tenant export storage reference: ${row.storageReference}`);
  }
  await rm(join(rootDirectory, row.storageReference), { force: true });
  await removeTenantExportPackageRecord(db, row.id);
}

console.log(`Removed ${expired.length} expired tenant export package(s).`);
