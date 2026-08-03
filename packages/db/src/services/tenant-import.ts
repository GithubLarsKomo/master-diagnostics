import type { TenantPortabilityExportDocument } from '@masters/domain';
import type { PortableRow, TenantPortabilityTable } from './tenant-export';

export interface TenantImportPlan {
  sourceTenantId: string;
  targetTenantId: string;
  idMap: Readonly<Record<string, string>>;
  tenant: PortableRow;
  users: PortableRow[];
  memberships: PortableRow[];
  tables: Record<TenantPortabilityTable, PortableRow[]>;
}

function requireId(row: PortableRow, path: string): string {
  if (typeof row.id !== 'string' || !row.id) {
    throw new Error(`Missing technical id at ${path}`);
  }
  return row.id;
}

function registerId(map: Map<string, string>, sourceId: string, path: string): void {
  if (map.has(sourceId)) {
    throw new Error(`Duplicate technical id ${sourceId} at ${path}`);
  }
  map.set(sourceId, crypto.randomUUID());
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

export function buildTenantImportPlan(
  document: TenantPortabilityExportDocument,
  targetTenantId = crypto.randomUUID(),
): TenantImportPlan {
  const sourceTenantId = requireId(document.tenant, '$.tenant');
  const idMap = new Map<string, string>();
  idMap.set(sourceTenantId, targetTenantId);

  document.users.forEach((row, index) => registerId(idMap, requireId(row, `$.users[${index}]`), `$.users[${index}]`));
  document.memberships.forEach((row, index) => registerId(idMap, requireId(row, `$.memberships[${index}]`), `$.memberships[${index}]`));
  for (const [tableName, rows] of Object.entries(document.data)) {
    rows.forEach((row, index) => registerId(idMap, requireId(row, `$.data.${tableName}[${index}]`), `$.data.${tableName}[${index}]`));
  }

  const remappedTables = Object.fromEntries(Object.entries(document.data).map(([tableName, rows]) => [
    tableName,
    rows.map((row) => remapRow(row, idMap, targetTenantId)),
  ])) as Record<TenantPortabilityTable, PortableRow[]>;

  return {
    sourceTenantId,
    targetTenantId,
    idMap: Object.freeze(Object.fromEntries(idMap)),
    tenant: remapRow(document.tenant, idMap, targetTenantId),
    users: document.users.map((row) => remapRow(row, idMap, targetTenantId)),
    memberships: document.memberships.map((row) => remapRow(row, idMap, targetTenantId)),
    tables: remappedTables,
  };
}
