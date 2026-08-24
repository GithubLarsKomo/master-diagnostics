import { createDatabase, type Database } from './client';
import {
  createPostgresDatabase,
  readPostgresConnectionConfig,
  type ConcretePostgresDatabase,
} from './postgres/client';

export type DatabaseEngine = 'libsql' | 'postgres';

export function readDatabaseEngine(env: NodeJS.ProcessEnv = process.env): DatabaseEngine {
  const raw = env.DB_ENGINE?.trim().toLowerCase() || 'libsql';
  if (raw === 'libsql' || raw === 'postgres') return raw;
  throw new Error('DB_ENGINE must be either libsql or postgres');
}

export interface RuntimeDatabase {
  engine: DatabaseEngine;
  db: Database;
  close: () => Promise<void>;
}

export function createRuntimeDatabase(env: NodeJS.ProcessEnv = process.env): RuntimeDatabase {
  const engine = readDatabaseEngine(env);
  if (engine === 'postgres') {
    const concrete: ConcretePostgresDatabase = createPostgresDatabase(
      readPostgresConnectionConfig(env),
    );
    return { engine, db: concrete.db, close: concrete.close };
  }

  return {
    engine,
    db: createDatabase(),
    close: async () => undefined,
  };
}
