import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'turso',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'http://localhost:8080',
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
