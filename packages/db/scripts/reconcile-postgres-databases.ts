import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';

const sourceUrl = process.env.SOURCE_POSTGRES_URL?.trim();
const targetUrl = process.env.RESTORE_DATABASE_URL?.trim();
const reportPath = process.env.POSTGRES_RESTORE_REPORT_PATH?.trim();
if (!sourceUrl) throw new Error('SOURCE_POSTGRES_URL is required');
if (!targetUrl) throw new Error('RESTORE_DATABASE_URL is required');

interface Column {
  readonly name: string;
  readonly dataType: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value as Uint8Array).toString('base64');
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normalize(column: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.dataType.includes('timestamp')) {
    if (value instanceof Date) return value.toISOString();
    return new Date(Date.parse(String(value))).toISOString();
  }
  if (column.dataType === 'date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
  if (column.dataType === 'json' || column.dataType === 'jsonb') return normalizeJson(value);
  if (column.dataType === 'bytea') return Buffer.from(value as Uint8Array).toString('base64');
  if (column.dataType === 'boolean') return Boolean(value);
  if (
    column.dataType === 'smallint' || column.dataType === 'integer' || column.dataType === 'bigint'
    || column.dataType === 'numeric' || column.dataType === 'decimal'
    || column.dataType === 'real' || column.dataType === 'double precision'
  ) return String(value);
  return normalizeJson(value);
}

function digest(lines: string[]): string {
  const hash = createHash('sha256');
  for (const line of [...lines].sort()) hash.update(line).update('\n');
  return hash.digest('hex');
}

async function tables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
      AND table_name <> '_masters_schema_migrations'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

async function columns(sql: Sql, table: string): Promise<Column[]> {
  const rows = await sql<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table}
    ORDER BY ordinal_position
  `;
  return rows.map((row) => ({ name: row.column_name, dataType: row.data_type }));
}

async function tableDigest(sql: Sql, table: string, cols: Column[]) {
  const rows = await sql.unsafe<Record<string, unknown>[]>(`SELECT * FROM ${quoteIdentifier(table)}`);
  const lines = rows.map((row) => JSON.stringify(Object.fromEntries(
    cols.map((column) => [column.name, normalize(column, row[column.name])]),
  )));
  return { count: lines.length, sha256: digest(lines) };
}

const source = postgres(sourceUrl, { max: 1, prepare: false });
const target = postgres(targetUrl, { max: 1, prepare: false });
try {
  const [sourceTables, targetTables] = await Promise.all([tables(source), tables(target)]);
  if (JSON.stringify(sourceTables) !== JSON.stringify(targetTables)) {
    throw new Error('PostgreSQL restore table set differs from source');
  }
  const results = [];
  for (const table of sourceTables) {
    const cols = await columns(source, table);
    const [left, right] = await Promise.all([tableDigest(source, table, cols), tableDigest(target, table, cols)]);
    results.push({ table, sourceCount: left.count, targetCount: right.count, sourceSha256: left.sha256, targetSha256: right.sha256, matches: left.count === right.count && left.sha256 === right.sha256 });
  }
  const mismatches = results.filter((result) => !result.matches).map((result) => result.table);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceEngine: 'postgresql',
    targetEngine: 'postgresql',
    tableCount: results.length,
    status: mismatches.length === 0 ? 'MATCH' : 'MISMATCH',
    criticalTables: {
      diagnosticResultSnapshots: results.find((result) => result.table === 'diagnostic_result_snapshots') ?? null,
      reportVersions: results.find((result) => result.table === 'report_versions') ?? null,
      interpretations: results.find((result) => result.table === 'interpretations') ?? null,
      auditEvents: results.find((result) => result.table === 'audit_events') ?? null,
    },
    tables: results,
    mismatches,
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, encoded, { mode: 0o600 });
  process.stdout.write(encoded);
  if (mismatches.length > 0) process.exitCode = 2;
} finally {
  await Promise.all([source.end({ timeout: 5 }), target.end({ timeout: 5 })]);
}
