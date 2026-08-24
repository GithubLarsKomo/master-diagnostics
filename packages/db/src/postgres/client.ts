import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Database } from '../client';

export interface PostgresConnectionConfig {
  url: string;
  poolMax: number;
  idleTimeoutSeconds: number;
  connectTimeoutSeconds: number;
}

export function readPostgresConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): PostgresConnectionConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is required for PostgreSQL');

  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('PostgreSQL DATABASE_URL must use postgres:// or postgresql://');
  }

  const parseBoundedInteger = (
    value: string | undefined,
    fallback: string,
    name: string,
    min: number,
    max: number,
  ): number => {
    const raw = value?.trim() || fallback;
    const parsedValue = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsedValue) || String(parsedValue) !== raw || parsedValue < min || parsedValue > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return parsedValue;
  };

  return {
    url,
    poolMax: parseBoundedInteger(env.DB_POOL_MAX, '10', 'DB_POOL_MAX', 1, 100),
    idleTimeoutSeconds: parseBoundedInteger(env.DB_IDLE_TIMEOUT_SECONDS, '20', 'DB_IDLE_TIMEOUT_SECONDS', 1, 600),
    connectTimeoutSeconds: parseBoundedInteger(env.DB_CONNECT_TIMEOUT_SECONDS, '10', 'DB_CONNECT_TIMEOUT_SECONDS', 1, 120),
  };
}

export interface ConcretePostgresDatabase {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

/**
 * Concrete PostgreSQL runtime binding.
 *
 * Existing application services remain typed against the canonical Database
 * surface. During convergence, Drizzle's PostgreSQL dialect executes those
 * service queries against the PostgreSQL schema mirror; CI exercises this
 * compatibility boundary against PostgreSQL 18.x before any production cutover.
 */
export function createPostgresDatabase(
  config: PostgresConnectionConfig = readPostgresConnectionConfig(),
): ConcretePostgresDatabase {
  const sql = postgres(config.url, {
    max: config.poolMax,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    prepare: true,
  });
  const pgDb = drizzle(sql);

  return {
    db: pgDb as unknown as Database,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
