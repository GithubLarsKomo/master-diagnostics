import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

export function createDatabase() {
  const client = createClient({
    url: process.env.DATABASE_URL ?? 'http://localhost:8080',
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
