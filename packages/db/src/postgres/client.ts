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

function serializeDateLike(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}

const preserveDateString = {
  serialize: serializeDateLike,
  parse: (value: string) => value,
};

const preserveTimestampString = {
  serialize: serializeDateLike,
  parse: normalizeIsoTimestamp,
};

const preserveJsonString = {
  serialize: (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value),
  parse: (value: string) => value,
};

/**
 * Concrete PostgreSQL runtime binding.
 *
 * The canonical service layer was deliberately written around portable scalar
 * values: ISO-8601 strings for date/time fields and JSON strings for serialized
 * payload columns. PostgreSQL stores those fields natively as date/timestamptz
 * and jsonb, so the driver normalizes the wire representation back to the same
 * service contract. This keeps locking, idempotency and audit code independent
 * of the physical database dialect during the convergence window.
 */
export function createPostgresDatabase(
  config: PostgresConnectionConfig = readPostgresConnectionConfig(),
): ConcretePostgresDatabase {
  const sql = postgres(config.url, {
    max: config.poolMax,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    prepare: true,
    types: {
      mastersDate: { to: 1082, from: [1082], ...preserveDateString },
      mastersTimestamp: { to: 1114, from: [1114], ...preserveTimestampString },
      mastersTimestamptz: { to: 1184, from: [1184], ...preserveTimestampString },
      mastersJsonb: { to: 3802, from: [3802], ...preserveJsonString },
    },
  });
  const pgDb = drizzle(sql);

  return {
    db: pgDb as unknown as Database,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
