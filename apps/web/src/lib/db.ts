import { createRuntimeDatabase, type RuntimeDatabase } from '@masters/db';

const globalForDb = globalThis as unknown as { mastersRuntimeDb?: RuntimeDatabase };

export const runtimeDb = globalForDb.mastersRuntimeDb ?? createRuntimeDatabase();
export const db = runtimeDb.db;
export const dbEngine = runtimeDb.engine;

if (process.env.NODE_ENV !== 'production') globalForDb.mastersRuntimeDb = runtimeDb;
