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

function normalizeIsoTimestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid timestamp: ${String(value)}`);
  }
  return parsed.toISOString();
}

const preserveDateString = {
  serialize: serializeDateLike,
  parse: (value: string) => value,
};

const preserveTimestampString = {
  serialize: serializeDateLike,
  parse: (value: string) => normalizeIsoTimestamp(value),
};

const preserveJsonString = {
  serialize: (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value),
  parse: (value: string) => value,
};

function normalizeCanonicalResultValue(value: unknown, columnType: number | undefined): unknown {
  if (columnType === 1114 || columnType === 1184) {
    return normalizeIsoTimestamp(value);
  }
  if (columnType === 1082) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  }
  if (columnType === 114 || columnType === 3802) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return value;
}

/**
 * Concrete PostgreSQL runtime binding.
 *
 * The canonical service layer was deliberately written around portable scalar
 * values: ISO-8601 strings for date/time fields and JSON strings for serialized
 * payload columns. PostgreSQL stores those fields natively as date/timestamptz
 * and jsonb, so the driver normalizes the parsed wire representation back to
 * that service contract. The result transform is intentional even alongside
 * custom parsers because postgres.js has built-in parsers for these native OIDs.
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
    transform: {
      value: {
        from: (value, column) => normalizeCanonicalResultValue(value, column?.type),
      },
    },
  });
  const pgDb = drizzle(sql);

  return {
    db: pgDb as unknown as Database,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
