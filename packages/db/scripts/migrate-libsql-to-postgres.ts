import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient, type Client, type InValue, type Row } from '@libsql/client';
import postgres, { type Sql } from 'postgres';

const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim();
const sourceAuthToken = process.env.SOURCE_DATABASE_AUTH_TOKEN?.trim();
const targetUrl = process.env.DATABASE_URL?.trim();
const reportPath = process.env.RECONCILIATION_REPORT_PATH?.trim();
const mode = (process.env.RECONCILIATION_MODE?.trim() || 'migrate') as 'migrate' | 'reconcile';

if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL is required');
if (!targetUrl) throw new Error('DATABASE_URL is required');
if (!['migrate', 'reconcile'].includes(mode)) throw new Error('RECONCILIATION_MODE must be migrate or reconcile');

const targetParsed = new URL(targetUrl);
if (!['postgres:', 'postgresql:'].includes(targetParsed.protocol)) {
  throw new Error('DATABASE_URL must point to PostgreSQL');
}

interface TargetColumn {
  readonly name: string;
  readonly dataType: string;
  readonly udtName: string;
}

interface TableReconciliation {
  readonly table: string;
  readonly sourceCount: number;
  readonly targetCount: number;
  readonly sourceSha256: string;
  readonly targetSha256: string;
  readonly matches: boolean;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rowValue(row: Row, name: string): unknown {
  return (row as Record<string, unknown>)[name];
}

function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value) !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 't') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'f') return false;
  throw new Error(`Cannot convert value to boolean: ${String(value)}`);
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function convertForTarget(column: TargetColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.dataType === 'boolean') return toBoolean(value);
  if (column.dataType === 'json' || column.dataType === 'jsonb') return parseJson(value);
  if (column.dataType === 'bytea') {
    if (value instanceof Uint8Array) return Buffer.from(value);
    return Buffer.from(String(value), 'base64');
  }
  if (
    column.dataType.includes('timestamp')
    || column.dataType === 'date'
    || column.dataType === 'time without time zone'
    || column.dataType === 'time with time zone'
  ) return String(value);
  return value as InValue;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(parsed).toISOString();
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : text;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return { __bytes_base64: Buffer.from(value as Uint8Array).toString('base64') };
    }
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJsonValue(item)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normalizeForHash(column: TargetColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.dataType === 'boolean') return toBoolean(value);
  if (column.dataType === 'json' || column.dataType === 'jsonb') return normalizeJsonValue(parseJson(value));
  if (column.dataType === 'bytea') {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value as Uint8Array).toString('base64');
    return String(value);
  }
  if (column.dataType.includes('timestamp')) return normalizeTimestamp(value);
  if (column.dataType === 'date') return normalizeDate(value);
  if (
    column.dataType === 'smallint'
    || column.dataType === 'integer'
    || column.dataType === 'bigint'
    || column.dataType === 'numeric'
    || column.dataType === 'decimal'
    || column.dataType === 'real'
    || column.dataType === 'double precision'
  ) return String(value);
  return normalizeJsonValue(value);
}

function sha256Lines(lines: string[]): string {
  const hash = createHash('sha256');
  for (const line of [...lines].sort()) hash.update(line).update('\n');
  return hash.digest('hex');
}

async function sourceTables(client: Client): Promise<string[]> {
  const result = await client.execute(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  return result.rows.map((row) => String(rowValue(row, 'name')));
}

async function targetTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> '_masters_schema_migrations'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

async function targetColumns(sql: Sql, table: string): Promise<TargetColumn[]> {
  const rows = await sql<{ column_name: string; data_type: string; udt_name: string }[]>`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
  return rows.map((row) => ({ name: row.column_name, dataType: row.data_type, udtName: row.udt_name }));
}

async function dependencyOrder(source: Client, tables: string[]): Promise<string[]> {
  const tableSet = new Set(tables);
  const dependencies = new Map<string, Set<string>>();
  for (const table of tables) {
    const fk = await source.execute(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`);
    const deps = new Set<string>();
    for (const row of fk.rows) {
      const dependency = String(rowValue(row, 'table'));
      if (dependency !== table && tableSet.has(dependency)) deps.add(dependency);
    }
    dependencies.set(table, deps);
  }

  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) => [...(dependencies.get(table) ?? [])].every((dep) => ordered.includes(dep)))
      .sort();
    if (ready.length === 0) {
      throw new Error(`Foreign-key dependency cycle prevents deterministic migration: ${[...remaining].sort().join(', ')}`);
    }
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

async function assertTargetEmpty(sql: Sql, tables: string[]): Promise<void> {
  for (const table of tables) {
    const rows = await sql.unsafe<{ count: string }[]>(`SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`);
    const count = Number(rows[0]?.count ?? '0');
    if (count !== 0) throw new Error(`PostgreSQL target table is not empty: ${table} (${count} rows)`);
  }
}

async function migrate(source: Client, target: Sql, orderedTables: string[]): Promise<void> {
  await assertTargetEmpty(target, orderedTables);
  await target.begin(async (tx) => {
    for (const table of orderedTables) {
      const columns = await targetColumns(tx as Sql, table);
      const sourceResult = await source.execute(`SELECT * FROM ${quoteIdentifier(table)}`);
      if (sourceResult.rows.length === 0) continue;
      const columnNames = columns.map((column) => column.name);
      const query = `INSERT INTO ${quoteIdentifier(table)} (${columnNames.map(quoteIdentifier).join(', ')}) VALUES (${columnNames.map((_, index) => `$${index + 1}`).join(', ')})`;
      for (const row of sourceResult.rows) {
        for (const column of columns) {
          if (!(column.name in (row as Record<string, unknown>))) {
            throw new Error(`Source table ${table} is missing target column ${column.name}`);
          }
        }
        const values = columns.map((column) => convertForTarget(column, rowValue(row, column.name)));
        await tx.unsafe(query, values as never[]);
      }
    }
  });
}

async function reconcileTable(source: Client, target: Sql, table: string): Promise<TableReconciliation> {
  const columns = await targetColumns(target, table);
  const sourceResult = await source.execute(`SELECT * FROM ${quoteIdentifier(table)}`);
  const targetRows = await target.unsafe<Record<string, unknown>[]>(`SELECT * FROM ${quoteIdentifier(table)}`);

  const sourceLines = sourceResult.rows.map((row) => JSON.stringify(Object.fromEntries(
    columns.map((column) => [column.name, normalizeForHash(column, rowValue(row, column.name))]),
  )));
  const targetLines = targetRows.map((row) => JSON.stringify(Object.fromEntries(
    columns.map((column) => [column.name, normalizeForHash(column, row[column.name])]),
  )));

  const sourceSha256 = sha256Lines(sourceLines);
  const targetSha256 = sha256Lines(targetLines);
  return {
    table,
    sourceCount: sourceLines.length,
    targetCount: targetLines.length,
    sourceSha256,
    targetSha256,
    matches: sourceLines.length === targetLines.length && sourceSha256 === targetSha256,
  };
}

const source = createClient({
  url: sourceUrl,
  ...(sourceAuthToken ? { authToken: sourceAuthToken } : {}),
});
const target = postgres(targetUrl, { max: 1, prepare: false });

try {
  const [sourceTableNames, targetTableNames] = await Promise.all([sourceTables(source), targetTables(target)]);
  const sourceSet = new Set(sourceTableNames);
  const missingSourceTables = targetTableNames.filter((table) => !sourceSet.has(table));
  if (missingSourceTables.length > 0) {
    throw new Error(`libSQL source is missing PostgreSQL tables: ${missingSourceTables.join(', ')}`);
  }
  const order = await dependencyOrder(source, targetTableNames);
  if (mode === 'migrate') await migrate(source, target, order);

  const tables: TableReconciliation[] = [];
  for (const table of targetTableNames) tables.push(await reconcileTable(source, target, table));
  const mismatches = tables.filter((table) => !table.matches);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceEngine: 'libsql',
    targetEngine: 'postgresql',
    migrationMode: mode,
    tableCount: tables.length,
    status: mismatches.length === 0 ? 'MATCH' : 'MISMATCH',
    criticalTables: {
      diagnosticResultSnapshots: tables.find((table) => table.table === 'diagnostic_result_snapshots') ?? null,
      reportVersions: tables.find((table) => table.table === 'report_versions') ?? null,
      interpretations: tables.find((table) => table.table === 'interpretations') ?? null,
      auditEvents: tables.find((table) => table.table === 'audit_events') ?? null,
    },
    tables,
    mismatches: mismatches.map((table) => table.table),
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, encoded, { mode: 0o600 });
  process.stdout.write(encoded);
  if (mismatches.length > 0) process.exitCode = 2;
} finally {
  source.close();
  await target.end({ timeout: 5 });
}
