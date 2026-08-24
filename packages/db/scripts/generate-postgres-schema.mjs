import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const sourceDir = join(packageRoot, 'src', 'schema');
const targetDir = join(packageRoot, 'src', 'postgres', 'schema.generated');

const compatSource = `import {
  boolean as pgBoolean,
  date as pgDate,
  index,
  integer as pgInteger,
  jsonb as pgJsonb,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export { index, uniqueIndex };
export const sqliteTable = pgTable;

const timestampNames = new Set([
  'active_from', 'backup_cutoff', 'confirmed_at', 'recovery_started_at',
  'source_db_committed_at', 'normalized_at', 'valid_from', 'valid_until',
]);

// This file is generated as a compatibility boundary while the canonical
// schema is still expressed with sqlite-core. `any` is deliberate here: a
// single wrapper can return different PostgreSQL column builders depending on
// the canonical column name/mode, and retaining the union would make Drizzle's
// fluent .default()/.references() types intersect incompatibly. The generated
// schema is still validated by drizzle-kit and by a real PostgreSQL 18.x CI.
export function text(name: string, config?: any): any {
  if (name === 'birth_date') return pgDate(name, { mode: 'string' });
  if (name.endsWith('_json')) return pgJsonb(name);
  if (name.endsWith('_at') || timestampNames.has(name)) {
    return pgTimestamp(name, { withTimezone: true, mode: 'string' });
  }
  return pgText(name, config);
}

export function integer(name: string, config?: any): any {
  if (config?.mode === 'boolean') return pgBoolean(name);
  if (config?.mode === 'timestamp') {
    return pgTimestamp(name, { withTimezone: true, mode: 'date' });
  }
  return pgInteger(name);
}
`;

const commonSource = `import { integer, text } from '../compat';

export const id = () => text('id').primaryKey();
export const tenantId = () => text('tenant_id').notNull();
export const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};
export const version = () => integer('version').notNull().default(1);
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await mkdir(join(packageRoot, 'src', 'postgres'), { recursive: true });
await writeFile(join(packageRoot, 'src', 'postgres', 'compat.ts'), compatSource, 'utf8');
await writeFile(join(targetDir, 'common.ts'), commonSource, 'utf8');

const files = (await readdir(sourceDir))
  .filter((name) => name.endsWith('.ts') && name !== 'common.ts')
  .sort();

const manifest = {
  version: 1,
  source: 'src/schema',
  generated: 'src/postgres/schema.generated',
  files: [],
  tables: [],
};

for (const name of files) {
  const source = await readFile(join(sourceDir, name), 'utf8');
  const generated = source.replaceAll("from 'drizzle-orm/sqlite-core'", "from '../compat'");
  await writeFile(join(targetDir, name), generated, 'utf8');

  const tables = [...source.matchAll(/sqliteTable\('([^']+)'/g)].map((match) => match[1]);
  manifest.tables.push(...tables);
  manifest.files.push({
    name,
    sourceSha256: sha256(source),
    generatedSha256: sha256(generated),
    tables,
  });
}

manifest.tables = [...new Set(manifest.tables)].sort();
await writeFile(join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  generatedFileCount: manifest.files.length,
  tableCount: manifest.tables.length,
  manifestSha256: sha256(JSON.stringify(manifest)),
}));
