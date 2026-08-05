import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  consumeTenantExportPackage,
  createTenantExportPackage,
  getAvailableTenantExportPackage,
  listExpiredTenantExportPackages,
} from '../src/services/tenant-export-packages';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-tenant-export-package-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const admin = {
  userId: 'admin-a',
  role: 'TENANT_ADMIN',
  authProvider: 'BETTER_AUTH' as const,
  sessionId: 'session-export-a',
};

describe('tenant export package service', () => {
  it('allows a valid token hash to be consumed exactly once and audits both events', async () => {
    const db = await createTestDatabase();
    const expiresAt = '2030-01-02T00:00:00.000Z';
    await createTenantExportPackage(db, {
      id: 'package-a',
      tenantId: 'tenant-a',
      tokenHash: 'hash-a',
      storageReference: 'package-a.mde',
      packageSha256: 'sha-a',
      actor: admin,
      expiresAt,
    });

    expect(await getAvailableTenantExportPackage(db, 'hash-a', '2030-01-01T00:00:00.000Z')).not.toBeNull();
    expect(await consumeTenantExportPackage(db, 'hash-a', '2030-01-01T00:00:01.000Z')).not.toBeNull();
    expect(await consumeTenantExportPackage(db, 'hash-a', '2030-01-01T00:00:02.000Z')).toBeNull();
    expect(await getAvailableTenantExportPackage(db, 'hash-a', '2030-01-01T00:00:03.000Z')).toBeNull();

    const audit = await db.select().from(schema.auditEvents);
    expect(audit.map((row) => row.action)).toEqual([
      'tenant_export.created',
      'tenant_export.downloaded',
    ]);
    expect(audit[0]).toMatchObject({
      actorUserId: 'admin-a',
      actorRole: 'TENANT_ADMIN',
      authProvider: 'BETTER_AUTH',
      sessionId: 'session-export-a',
      source: 'WEB',
    });
    expect(audit[1]).toMatchObject({
      actorUserId: null,
      actorRole: null,
      authProvider: null,
      sessionId: null,
      source: 'DOWNLOAD_LINK',
    });
    expect(JSON.parse(audit[1]!.afterJson ?? '{}')).toMatchObject({
      createdByUserId: 'admin-a',
      packageSha256: 'sha-a',
    });
  });

  it('rejects expired packages and exposes them for cleanup', async () => {
    const db = await createTestDatabase();
    await createTenantExportPackage(db, {
      id: 'package-expired',
      tenantId: 'tenant-a',
      tokenHash: 'hash-expired',
      storageReference: 'package-expired.mde',
      packageSha256: 'sha-expired',
      actor: admin,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(await getAvailableTenantExportPackage(db, 'hash-expired', '2030-01-02T00:00:00.000Z')).toBeNull();
    expect(await consumeTenantExportPackage(db, 'hash-expired', '2030-01-02T00:00:00.000Z')).toBeNull();
    const expired = await listExpiredTenantExportPackages(db, '2030-01-02T00:00:00.000Z');
    expect(expired.map((row) => row.id)).toEqual(['package-expired']);
  });
});
