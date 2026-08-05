import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema';

export interface DatabaseConnectionConfig {
  url: string;
  authToken?: string;
}

export function createDatabaseFromConfig(config: DatabaseConnectionConfig) {
  const client = createClient({
    url: config.url,
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });
  return drizzle(client, { schema });
}

export function createDatabase() {
  const databaseAuthToken = process.env.DATABASE_AUTH_TOKEN;
  return createDatabaseFromConfig({
    url: process.env.DATABASE_URL ?? 'http://localhost:8080',
    ...(databaseAuthToken ? { authToken: databaseAuthToken } : {}),
  });
}

export async function migrateDatabase(
  db: ReturnType<typeof createDatabaseFromConfig>,
  migrationsFolder: string,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export type Database = ReturnType<typeof createDatabase>;
