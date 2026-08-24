import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const parsed = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
  throw new Error('DATABASE_URL must be PostgreSQL for this migration runner');
}

const migrationsDir = resolve(process.env.POSTGRES_MIGRATIONS_DIR || 'migrations-postgres-ci');
const names = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
if (names.length === 0) throw new Error(`No PostgreSQL migrations found in ${migrationsDir}`);

const migrations = [];
for (const name of names) {
  const sql = await readFile(resolve(migrationsDir, name), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  migrations.push({ name, sql, checksum });
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const body = [];
body.push('\\set ON_ERROR_STOP on');
body.push("SELECT pg_advisory_lock(hashtext('masters-diagnostics-postgres-migrations')); ");
body.push(`CREATE TABLE IF NOT EXISTS _masters_schema_migrations (
  filename text PRIMARY KEY,
  checksum_sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);`);

for (const migration of migrations) {
  const file = quoteLiteral(migration.name);
  const checksum = quoteLiteral(migration.checksum);
  body.push(`DO $$
DECLARE recorded text;
BEGIN
  SELECT checksum_sha256 INTO recorded FROM _masters_schema_migrations WHERE filename = ${file};
  IF recorded IS NOT NULL AND recorded <> ${checksum} THEN
    RAISE EXCEPTION 'Migration checksum mismatch for %', ${file};
  END IF;
END $$;`);
  body.push(`SELECT CASE WHEN EXISTS (
  SELECT 1 FROM _masters_schema_migrations WHERE filename = ${file}
) THEN 'true' ELSE 'false' END AS already_applied \\gset`);
  body.push('\\if :already_applied');
  body.push(`\\echo 'skip ${migration.name} (already applied)'`);
  body.push('\\else');
  body.push('BEGIN;');
  body.push(migration.sql);
  body.push(`INSERT INTO _masters_schema_migrations(filename, checksum_sha256) VALUES (${file}, ${checksum});`);
  body.push('COMMIT;');
  body.push('\\endif');
}

body.push("SELECT pg_advisory_unlock(hashtext('masters-diagnostics-postgres-migrations')); ");

const result = spawnSync('psql', [databaseUrl, '--no-psqlrc', '--quiet'], {
  input: `${body.join('\n')}\n`,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'PostgreSQL migration failed\n');
  process.exit(result.status ?? 1);
}

process.stdout.write(JSON.stringify({
  migrationCount: migrations.length,
  files: migrations.map(({ name, checksum }) => ({ name, checksumSha256: checksum })),
}) + '\n');
