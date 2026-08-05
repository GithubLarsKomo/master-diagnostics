import type { Database } from '../client';

export const TENANT_PORTABILITY_TABLES = [
  'athletes',
  'athlete_snapshots',
  'coach_athlete_assignments',
  'consents',
  'athlete_guardians',
  'athlete_deletion_requests',
  'protocol_templates',
  'protocol_template_versions',
  'zone_rule_versions',
  'tests',
  'test_plan_snapshots',
  'test_safety_checklist_confirmations',
  'test_termination_events',
  'test_stages',
  'rest_measurements',
  'recovery_measurements',
  'quality_flags',
  'measurement_corrections',
  'threshold_runs',
  'threshold_results',
  'diagnostic_result_snapshots',
  'interpretations',
  'zone_profiles',
  'report_versions',
  'audit_events',
  'audit_event_privacy_redactions',
] as const;

export type TenantPortabilityTable = (typeof TENANT_PORTABILITY_TABLES)[number];
export type PortableRow = Record<string, unknown>;

export interface TenantExportColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface TenantPortabilityExportSource {
  tenant: PortableRow;
  users: PortableRow[];
  memberships: PortableRow[];
  tables: Record<TenantPortabilityTable, PortableRow[]>;
  dataDictionary: Record<string, TenantExportColumn[]>;
}

function plainRows(rows: readonly Record<string, unknown>[]): PortableRow[] {
  return rows.map((row) => ({ ...row }));
}

async function tableDictionary(db: Database, tableName: string): Promise<TenantExportColumn[]> {
  const result = await db.$client.execute(`PRAGMA table_info("${tableName}")`);
  return result.rows.map((row) => ({
    name: String(row.name ?? ''),
    type: String(row.type ?? ''),
    notNull: Number(row.notnull ?? 0) === 1,
    primaryKey: Number(row.pk ?? 0) === 1,
  }));
}

export async function getTenantPortabilityExportSource(
  db: Database,
  tenantId: string,
): Promise<TenantPortabilityExportSource | null> {
  const tenantResult = await db.$client.execute({
    sql: 'SELECT * FROM tenants WHERE id = ? LIMIT 1',
    args: [tenantId],
  });
  const tenant = tenantResult.rows[0];
  if (!tenant) return null;

  const membershipsResult = await db.$client.execute({
    sql: 'SELECT * FROM tenant_memberships WHERE tenant_id = ? ORDER BY created_at, id',
    args: [tenantId],
  });
  const usersResult = await db.$client.execute({
    sql: `SELECT users.*
      FROM users
      WHERE users.id IN (
        SELECT user_id FROM tenant_memberships WHERE tenant_id = ?
      )
      ORDER BY users.created_at, users.id`,
    args: [tenantId],
  });

  const tableEntries = await Promise.all(TENANT_PORTABILITY_TABLES.map(async (tableName) => {
    const result = await db.$client.execute({
      sql: `SELECT * FROM "${tableName}" WHERE tenant_id = ? ORDER BY created_at, id`,
      args: [tenantId],
    });
    return [tableName, plainRows(result.rows)] as const;
  }));

  const dictionaryTableNames = ['tenants', 'users', 'tenant_memberships', ...TENANT_PORTABILITY_TABLES];
  const dictionaryEntries = await Promise.all(dictionaryTableNames.map(async (tableName) => (
    [tableName, await tableDictionary(db, tableName)] as const
  )));

  return {
    tenant: { ...tenant },
    users: plainRows(usersResult.rows),
    memberships: plainRows(membershipsResult.rows),
    tables: Object.fromEntries(tableEntries) as Record<TenantPortabilityTable, PortableRow[]>,
    dataDictionary: Object.fromEntries(dictionaryEntries),
  };
}
