import type { TenantPortabilityExportDocument } from '@masters/domain';
import type { Database } from '../client';
import {
  TENANT_PORTABILITY_TABLES,
  type PortableRow,
  type TenantPortabilityTable,
} from './tenant-export';

export interface TenantImportPlan {
  sourceTenantId: string;
  targetTenantId: string;
  idMap: Readonly<Record<string, string>>;
  reusedUserIds: readonly string[];
  tenant: PortableRow;
  users: PortableRow[];
  memberships: PortableRow[];
  tables: Record<TenantPortabilityTable, PortableRow[]>;
}

export interface PrepareTenantImportOptions {
  targetTenantId?: string;
  targetSlug?: string;
  targetDeploymentMode?: 'CLUB' | 'SAAS';
}

export interface ExecuteTenantImportOptions extends PrepareTenantImportOptions {
  /** Test-only fault injection used to prove transaction rollback. */
  failAfterTable?: TenantPortabilityTable;
}

type SqlValue = string | number | bigint | boolean | Uint8Array | null;

function requireId(row: PortableRow, path: string): string {
  if (typeof row.id !== 'string' || !row.id) {
    throw new Error(`Missing technical id at ${path}`);
  }
  return row.id;
}

function registerId(
  map: Map<string, string>,
  sourceId: string,
  path: string,
  override?: string,
): void {
  if (map.has(sourceId)) {
    throw new Error(`Duplicate technical id ${sourceId} at ${path}`);
  }
  map.set(sourceId, override ?? crypto.randomUUID());
}

function remapRow(row: PortableRow, idMap: ReadonlyMap<string, string>, targetTenantId: string): PortableRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (key === 'tenant_id') return [key, targetTenantId];
    if (typeof value === 'string' && (key === 'id' || key.endsWith('_id'))) {
      return [key, idMap.get(value) ?? value];
    }
    return [key, value];
  }));
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function asSqlValue(value: unknown, path: string): SqlValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(`Unsupported SQL value at ${path}`);
}

function insertStatement(tableName: string, row: PortableRow) {
  const entries = Object.entries(row);
  if (entries.length === 0) throw new Error(`Cannot import empty row into ${tableName}`);
  return {
    sql: `INSERT INTO ${quoteIdentifier(tableName)} (${entries.map(([column]) => quoteIdentifier(column)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`,
    args: entries.map(([column, value]) => asSqlValue(value, `${tableName}.${column}`)),
  };
}

export function buildTenantImportPlan(
  document: TenantPortabilityExportDocument,
  targetTenantId: string = crypto.randomUUID(),
  idOverrides: Readonly<Record<string, string>> = {},
): TenantImportPlan {
  const sourceTenantId = requireId(document.tenant, '$.tenant');
  const idMap = new Map<string, string>();
  idMap.set(sourceTenantId, targetTenantId);

  document.users.forEach((row, index) => {
    const sourceId = requireId(row, `$.users[${index}]`);
    registerId(idMap, sourceId, `$.users[${index}]`, idOverrides[sourceId]);
  });
  document.memberships.forEach((row, index) => {
    const sourceId = requireId(row, `$.memberships[${index}]`);
    registerId(idMap, sourceId, `$.memberships[${index}]`, idOverrides[sourceId]);
  });
  for (const [tableName, rows] of Object.entries(document.data)) {
    rows.forEach((row, index) => {
      const sourceId = requireId(row, `$.data.${tableName}[${index}]`);
      registerId(idMap, sourceId, `$.data.${tableName}[${index}]`, idOverrides[sourceId]);
    });
  }

  const remappedTables = Object.fromEntries(Object.entries(document.data).map(([tableName, rows]) => [
    tableName,
    rows.map((row) => remapRow(row, idMap, targetTenantId)),
  ])) as Record<TenantPortabilityTable, PortableRow[]>;

  return {
    sourceTenantId,
    targetTenantId,
    idMap: Object.freeze(Object.fromEntries(idMap)),
    reusedUserIds: Object.freeze([]),
    tenant: remapRow(document.tenant, idMap, targetTenantId),
    users: document.users.map((row) => remapRow(row, idMap, targetTenantId)),
    memberships: document.memberships.map((row) => remapRow(row, idMap, targetTenantId)),
    tables: remappedTables,
  };
}

export async function prepareTenantImportPlan(
  db: Database,
  document: TenantPortabilityExportDocument,
  options: PrepareTenantImportOptions = {},
): Promise<TenantImportPlan> {
  const targetTenantId: string = options.targetTenantId ?? crypto.randomUUID();
  const targetTenant = await db.$client.execute({
    sql: 'SELECT id FROM tenants WHERE id = ? LIMIT 1',
    args: [targetTenantId],
  });
  if (targetTenant.rows.length > 0) {
    throw new Error('Tenant import target id already exists');
  }

  const targetSlug = options.targetSlug ?? String(document.tenant.slug ?? '');
  if (!targetSlug) throw new Error('Tenant import requires a target slug');
  const slugConflict = await db.$client.execute({
    sql: 'SELECT id FROM tenants WHERE slug = ? LIMIT 1',
    args: [targetSlug],
  });
  if (slugConflict.rows.length > 0) {
    throw new Error('Tenant import target slug already exists');
  }

  const userOverrides: Record<string, string> = {};
  const reusedUserIds = new Set<string>();
  for (const [index, row] of document.users.entries()) {
    const sourceId = requireId(row, `$.users[${index}]`);
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (!email) throw new Error(`Missing user email at $.users[${index}]`);
    const existing = await db.$client.execute({
      sql: 'SELECT id FROM users WHERE lower(email) = ? LIMIT 1',
      args: [email],
    });
    const existingId = existing.rows[0]?.id;
    if (typeof existingId === 'string' && existingId) {
      userOverrides[sourceId] = existingId;
      reusedUserIds.add(existingId);
    }
  }

  const plan = buildTenantImportPlan(document, targetTenantId, userOverrides);
  const tenant = {
    ...plan.tenant,
    slug: targetSlug,
    ...(options.targetDeploymentMode ? { deployment_mode: options.targetDeploymentMode } : {}),
  };

  return {
    ...plan,
    tenant,
    reusedUserIds: Object.freeze([...reusedUserIds]),
  };
}

export async function executeTenantImportDatabase(
  db: Database,
  document: TenantPortabilityExportDocument,
  options: ExecuteTenantImportOptions = {},
): Promise<TenantImportPlan> {
  const plan = await prepareTenantImportPlan(db, document, options);
  const transaction = await db.$client.transaction('write');

  try {
    await transaction.execute('PRAGMA defer_foreign_keys = ON');
    await transaction.execute(insertStatement('tenants', plan.tenant));

    const reusedUsers = new Set(plan.reusedUserIds);
    for (const row of plan.users) {
      if (typeof row.id === 'string' && reusedUsers.has(row.id)) continue;
      await transaction.execute(insertStatement('users', row));
    }
    for (const row of plan.memberships) {
      await transaction.execute(insertStatement('tenant_memberships', row));
    }

    for (const tableName of TENANT_PORTABILITY_TABLES) {
      for (const row of plan.tables[tableName] ?? []) {
        await transaction.execute(insertStatement(tableName, row));
      }
      if (options.failAfterTable === tableName) {
        throw new Error(`Injected tenant import failure after ${tableName}`);
      }
    }

    const now = new Date().toISOString();
    const adminMembership = plan.memberships.find((row) => row.role === 'TENANT_ADMIN' && row.active !== 0 && row.active !== false);
    await transaction.execute(insertStatement('audit_events', {
      id: crypto.randomUUID(),
      tenant_id: plan.targetTenantId,
      occurred_at: now,
      actor_user_id: typeof adminMembership?.user_id === 'string' ? adminMembership.user_id : null,
      actor_role: 'TENANT_ADMIN',
      action: 'tenant.import.completed',
      entity_type: 'tenant',
      entity_id: plan.targetTenantId,
      source: 'TENANT_IMPORT',
      correlation_id: crypto.randomUUID(),
      after_json: JSON.stringify({ sourceTenantId: plan.sourceTenantId }),
      created_at: now,
      updated_at: now,
    }));

    await transaction.commit();
    return plan;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
