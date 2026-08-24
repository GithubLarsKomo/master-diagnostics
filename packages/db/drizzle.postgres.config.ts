import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/postgres/schema.generated/index.ts',
  out: './migrations-postgres-ci',
  strict: true,
  verbose: true,
});
