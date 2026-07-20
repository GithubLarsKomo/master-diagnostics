import { migrate } from 'drizzle-orm/libsql/migrator';
import { createDatabase } from './client';

await migrate(createDatabase(), { migrationsFolder: './migrations' });
console.log('Database migrations completed.');
