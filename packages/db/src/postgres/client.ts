import { drizzle } from 'drizzle-orm/pg-proxy';

export type PostgresQueryMethod = 'all' | 'execute' | 'values' | 'get';

export interface PostgresProxyResult {
  rows: unknown[];
}

export type PostgresQueryExecutor = (
  query: string,
  params: unknown[],
  method: PostgresQueryMethod,
) => Promise<PostgresProxyResult>;

export interface PostgresConnectionConfig {
  url: string;
  poolMax: number;
}

export function readPostgresConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): PostgresConnectionConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required for PostgreSQL');
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('PostgreSQL DATABASE_URL must use postgres:// or postgresql://');
  }

  const rawPoolMax = env.DB_POOL_MAX?.trim() || '10';
  const poolMax = Number.parseInt(rawPoolMax, 10);
  if (!Number.isInteger(poolMax) || String(poolMax) !== rawPoolMax || poolMax < 1 || poolMax > 100) {
    throw new Error('DB_POOL_MAX must be an integer between 1 and 100');
  }

  return { url, poolMax };
}

/**
 * Creates a PostgreSQL Drizzle database over an injected executor.
 *
 * The executor is intentionally injected in this migration phase. This keeps
 * @masters/db free of a second concrete network driver while the existing
 * libSQL runtime remains authoritative. The production PostgreSQL driver is
 * bound only at the cutover gate defined by ADR-0023.
 */
export function createPostgresDatabaseFromExecutor(executor: PostgresQueryExecutor) {
  return drizzle(executor as Parameters<typeof drizzle>[0]);
}

export type PostgresDatabase = ReturnType<typeof createPostgresDatabaseFromExecutor>;
