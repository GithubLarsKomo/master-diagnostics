import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import type { TenantPortabilityExportDocument } from '@masters/domain';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { executeTenantImportDatabase } from '../src/services/tenant-import';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-tenant-import-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

function fixture(): TenantPortabilityExportDocument {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const updatedAt = '2026-01-02T00:00:00.000Z';
  return {
    schemaVersion: 'masters-tenant-export-v1',
    manifest: {
      schemaVersion: 'masters-tenant-export-v1',
      exportedAt: '2026-08-03T10:00:00.000Z',
      tenantId: 'tenant-source',
      sections: {},
      reportArtifacts: [],
    },
    tenant: {
      id: 'tenant-source', slug: 'source-club', name: 'Source Club', deployment_mode: 'CLUB',
      timezone: 'Europe/Berlin', locale: 'de', retention_years: 10, created_at: createdAt, updated_at: updatedAt,
    },
    users: [{
      id: 'user-source', email: 'admin@example.test', display_name: 'Admin Source', preferred_locale: 'de',
      disabled_at: null, created_at: createdAt, updated_at: updatedAt,
    }],
    memberships: [{
      id: 'membership-source', tenant_id: 'tenant-source', user_id: 'user-source', role: 'TENANT_ADMIN', active: 1,
      created_at: createdAt, updated_at: updatedAt,
    }],
    data: {
      athletes: [{
        id: 'athlete-source', tenant_id: 'tenant-source', linked_user_id: null,
        first_name: 'Max', last_name: 'Athlete', birth_date: '1980-01-01', reference_category: 'Masters',
        height_cm: 180, current_weight_kg_x100: 8000, primary_sport: 'Rudern', primary_discipline: 'Einer',
        training_status: 'TRAINED', consent_blocked_at: null, deleted_at: null,
        created_at: createdAt, updated_at: updatedAt,
      }],
    } as TenantPortabilityExportDocument['data'],
    reportArtifacts: [],
    dataDictionary: {},
  };
}

describe('atomic tenant portability import', () => {
  it('imports a new tenant atomically and appends an import audit event', async () => {
    const db = await createTestDatabase();
    const plan = await executeTenantImportDatabase(db, fixture(), {
      targetTenantId: 'tenant-target',
      targetSlug: 'restored-club',
      targetDeploymentMode: 'CLUB',
    });

    expect(plan.targetTenantId).toBe('tenant-target');
    const tenantRows = await db.$client.execute({ sql: 'SELECT id, slug FROM tenants WHERE id = ?', args: ['tenant-target'] });
    expect(tenantRows.rows[0]).toMatchObject({ id: 'tenant-target', slug: 'restored-club' });

    const athleteRows = await db.$client.execute({ sql: 'SELECT tenant_id, first_name FROM athletes', args: [] });
    expect(athleteRows.rows).toHaveLength(1);
    expect(athleteRows.rows[0]).toMatchObject({ tenant_id: 'tenant-target', first_name: 'Max' });

    const auditRows = await db.$client.execute({
      sql: "SELECT action, tenant_id FROM audit_events WHERE action = 'tenant.import.completed'",
      args: [],
    });
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]).toMatchObject({ action: 'tenant.import.completed', tenant_id: 'tenant-target' });
  });

  it('rolls back every inserted row when a failure occurs mid-import', async () => {
    const db = await createTestDatabase();
    await expect(executeTenantImportDatabase(db, fixture(), {
      targetTenantId: 'tenant-target',
      targetSlug: 'restored-club',
      targetDeploymentMode: 'CLUB',
      failAfterTable: 'athletes',
    })).rejects.toThrow(/Injected tenant import failure/);

    for (const tableName of ['tenants', 'users', 'tenant_memberships', 'athletes']) {
      const result = await db.$client.execute(`SELECT COUNT(*) AS count FROM ${tableName}`);
      expect(Number(result.rows[0]?.count ?? -1), tableName).toBe(0);
    }
    const auditRows = await db.$client.execute("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'tenant.import.completed'");
    expect(Number(auditRows.rows[0]?.count ?? -1)).toBe(0);
  });

  it('reuses an existing globally unique SaaS user instead of duplicating the email', async () => {
    const db = await createTestDatabase();
    const now = new Date().toISOString();
    await db.insert(schema.users).values({
      id: 'existing-user', email: 'admin@example.test', displayName: 'Existing Admin', createdAt: now, updatedAt: now,
    });

    const plan = await executeTenantImportDatabase(db, fixture(), {
      targetTenantId: 'tenant-target',
      targetSlug: 'restored-saas',
      targetDeploymentMode: 'SAAS',
    });

    expect(plan.reusedUserIds).toContain('existing-user');
    expect(plan.memberships[0]?.user_id).toBe('existing-user');
    const users = await db.$client.execute({ sql: 'SELECT id, email FROM users WHERE lower(email) = ?', args: ['admin@example.test'] });
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]?.id).toBe('existing-user');
  });
});
