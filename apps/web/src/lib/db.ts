import { createDatabase } from '@masters/db';

const globalForDb = globalThis as unknown as { mastersDb?: ReturnType<typeof createDatabase> };
export const db = globalForDb.mastersDb ?? createDatabase();
if (process.env.NODE_ENV !== 'production') globalForDb.mastersDb = db;
