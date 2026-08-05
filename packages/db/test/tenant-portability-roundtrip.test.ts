import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';
import {
  TENANT_EXPORT_SCHEMA_VERSION,
  type TenantPortabilityExportDocument,
} from '@masters/domain';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { getTenantPortabilityExportSource, type PortableRow } from '../src/services/tenant-export';
import { executeTenantImportDatabase } from '../src/services/tenant-import';

async function createTestDatabase(label: string): Promise<Database> {
  const databasePath = `/tmp/masters-tenant-roundtrip-${label}-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

function normalizeRow(row: PortableRow, inverseIdMap: Readonly<Record<string, string>>, sourceTenantId: string): PortableRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (key === 'tenant_id') return [key, sourceTenantId];
    if (typeof value === 'string' && (key === 'id' || key.endsWith('_id'))) {
      return [key, inverseIdMap[value] ?? value];
    }
    return [key, value];
  }));
}

function withoutImportAudit(rows: readonly PortableRow[]): PortableRow[] {
  return rows.filter((row) => row.action !== 'tenant.import.completed');
}

describe('tenant portability roundtrip', () => {
  it('preserves exported domain data and audit-redaction proof while remapping technical ids', async () => {
    const sourceDb = await createTestDatabase('source');
    const targetDb = await createTestDatabase('target');
    const createdAt = '2026-05-01T10:00:00.000Z';
    const updatedAt = '2026-05-02T11:00:00.000Z';

    await sourceDb.insert(schema.tenants).values({
      id: 'tenant-source', slug: 'source-club', name: 'Source Club', deploymentMode: 'CLUB',
      timezone: 'Europe/Berlin', locale: 'de', retentionYears: 10, createdAt, updatedAt,
    });
    await sourceDb.insert(schema.users).values({
      id: 'user-source', email: 'roundtrip@example.test', displayName: 'Roundtrip Admin', preferredLocale: 'de',
      createdAt, updatedAt,
    });
    await sourceDb.insert(schema.tenantMemberships).values({
      id: 'membership-source', tenantId: 'tenant-source', userId: 'user-source', role: 'TENANT_ADMIN', active: true,
      createdAt, updatedAt,
    });
    await sourceDb.insert(schema.athletes).values({
      id: 'athlete-source', tenantId: 'tenant-source', linkedUserId: 'user-source', firstName: 'Max', lastName: 'Mustermann',
      birthDate: '1975-06-15', referenceCategory: 'MASTERS', heightCm: 184, currentWeightKgX100: 8150,
      primarySport: 'ROWING', primaryDiscipline: 'SINGLE', trainingStatus: 'TRAINED', createdAt, updatedAt,
    });
    await sourceDb.insert(schema.auditEvents).values({
      id: 'audit-source', tenantId: 'tenant-source', occurredAt: createdAt, actorUserId: null,
      actorRole: 'TENANT_ADMIN', action: 'roundtrip.fixture.created', entityType: 'athlete', entityId: 'athlete-source',
      source: 'TEST', correlationId: 'corr-source', reason: '[REDACTED]',
      beforeJson: '{"auditSchemaVersion":3,"privacyRedacted":true}',
      afterJson: '{"auditSchemaVersion":3,"privacyRedacted":true}', createdAt, updatedAt,
    });
    await sourceDb.insert(schema.auditEventPrivacyRedactions).values({
      id: 'redaction-source', tenantId: 'tenant-source', auditEventId: 'audit-source',
      subjectAthleteId: 'athlete-source', redactionVersion: 1,
      redactActorUserId: true, redactSessionId: false, redactReason: true,
      redactBeforeJson: true, redactAfterJson: true, requestedByUserId: 'user-source',
      maintenanceReference: 'PRIVACY/ROUNDTRIP-1', redactedAt: updatedAt,
      createdAt: updatedAt, updatedAt,
    });

    const exported = await getTenantPortabilityExportSource(sourceDb, 'tenant-source');
    expect(exported).not.toBeNull();
    if (!exported) throw new Error('source export unavailable');
    expect(exported.tables.audit_event_privacy_redactions).toHaveLength(1);

    const document: TenantPortabilityExportDocument = {
      schemaVersion: TENANT_EXPORT_SCHEMA_VERSION,
      manifest: {
        schemaVersion: TENANT_EXPORT_SCHEMA_VERSION,
        exportedAt: '2026-08-03T15:00:00.000Z',
        tenantId: 'tenant-source',
        sections: {},
        reportArtifacts: [],
      },
      tenant: exported.tenant,
      users: exported.users,
      memberships: exported.memberships,
      data: exported.tables,
      reportArtifacts: [],
      dataDictionary: exported.dataDictionary,
    };

    const plan = await executeTenantImportDatabase(targetDb, document, {
      targetTenantId: 'tenant-target',
      targetSlug: 'restored-club',
      targetDeploymentMode: 'CLUB',
    });
    const reExported = await getTenantPortabilityExportSource(targetDb, 'tenant-target');
    expect(reExported).not.toBeNull();
    if (!reExported) throw new Error('target export unavailable');

    const inverseIdMap = Object.fromEntries(Object.entries(plan.idMap).map(([sourceId, targetId]) => [targetId, sourceId]));
    expect(normalizeRow(reExported.tenant, inverseIdMap, plan.sourceTenantId))
      .toEqual({ ...exported.tenant, slug: 'restored-club' });
    expect(reExported.users.map((row) => normalizeRow(row, inverseIdMap, plan.sourceTenantId))).toEqual(exported.users);
    expect(reExported.memberships.map((row) => normalizeRow(row, inverseIdMap, plan.sourceTenantId))).toEqual(exported.memberships);

    for (const [tableName, sourceRows] of Object.entries(exported.tables)) {
      const targetRows = tableName === 'audit_events'
        ? withoutImportAudit(reExported.tables.audit_events)
        : reExported.tables[tableName as keyof typeof reExported.tables];
      expect(targetRows.map((row) => normalizeRow(row, inverseIdMap, plan.sourceTenantId)), tableName)
        .toEqual(sourceRows);
    }

    expect(reExported.dataDictionary).toEqual(exported.dataDictionary);
  });
});
