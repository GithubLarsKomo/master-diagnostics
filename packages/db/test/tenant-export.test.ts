import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { getTenantPortabilityExportSource } from '../src/services/tenant-export';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-tenant-export-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

describe('tenant portability export', () => {
  it('exports only the requested tenant and excludes operational security tables', async () => {
    const db = await createTestDatabase();
    const now = new Date().toISOString();

    await db.insert(schema.tenants).values([
      { id: 'tenant-a', slug: 'a', name: 'Tenant A', deploymentMode: 'CLUB', createdAt: now, updatedAt: now },
      { id: 'tenant-b', slug: 'b', name: 'Tenant B', deploymentMode: 'SAAS', createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.users).values([
      { id: 'user-a', email: 'a@example.test', displayName: 'Admin A', createdAt: now, updatedAt: now },
      { id: 'user-b', email: 'b@example.test', displayName: 'Admin B', createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.tenantMemberships).values([
      { id: 'membership-a', tenantId: 'tenant-a', userId: 'user-a', role: 'TENANT_ADMIN', createdAt: now, updatedAt: now },
      { id: 'membership-b', tenantId: 'tenant-b', userId: 'user-b', role: 'TENANT_ADMIN', createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.athletes).values([
      {
        id: 'athlete-a', tenantId: 'tenant-a', firstName: 'Alpha', lastName: 'Athlete', birthDate: '1980-01-01',
        referenceCategory: 'Masters', heightCm: 180, currentWeightKgX100: 8000, primarySport: 'Rudern',
        primaryDiscipline: 'Einer', trainingStatus: 'TRAINED', createdAt: now, updatedAt: now,
      },
      {
        id: 'athlete-b', tenantId: 'tenant-b', firstName: 'Beta', lastName: 'Athlete', birthDate: '1981-01-01',
        referenceCategory: 'Masters', heightCm: 181, currentWeightKgX100: 8100, primarySport: 'Rudern',
        primaryDiscipline: 'Einer', trainingStatus: 'TRAINED', createdAt: now, updatedAt: now,
      },
    ]);
    await db.insert(schema.auditEvents).values([
      {
        id: 'audit-a', tenantId: 'tenant-a', occurredAt: now, actorUserId: 'user-a', actorRole: 'TENANT_ADMIN',
        action: 'tenant.exported', entityType: 'tenant', entityId: 'tenant-a', source: 'test', correlationId: 'corr-a',
        createdAt: now, updatedAt: now,
      },
      {
        id: 'audit-b', tenantId: 'tenant-b', occurredAt: now, actorUserId: 'user-b', actorRole: 'TENANT_ADMIN',
        action: 'tenant.exported', entityType: 'tenant', entityId: 'tenant-b', source: 'test', correlationId: 'corr-b',
        createdAt: now, updatedAt: now,
      },
    ]);
    await db.insert(schema.testLocks).values({
      id: 'lock-a', tenantId: 'tenant-a', testId: 'nonportable-test', ownerUserId: 'user-a', tokenHash: 'must-not-export',
      acquiredAt: now, expiresAt: now, createdAt: now, updatedAt: now,
    }).catch(() => undefined);

    const exported = await getTenantPortabilityExportSource(db, 'tenant-a');
    expect(exported).not.toBeNull();
    expect(exported?.tenant.id).toBe('tenant-a');
    expect(exported?.users.map((row) => row.id)).toEqual(['user-a']);
    expect(exported?.memberships.map((row) => row.id)).toEqual(['membership-a']);
    expect(exported?.tables.athletes.map((row) => row.id)).toEqual(['athlete-a']);
    expect(exported?.tables.audit_events.map((row) => row.id)).toEqual(['audit-a']);
    expect(Object.keys(exported?.tables ?? {})).not.toContain('test_locks');
    expect(JSON.stringify(exported)).not.toContain('must-not-export');
    expect(exported?.dataDictionary.athletes.some((column) => column.name === 'tenant_id')).toBe(true);
  });
});
