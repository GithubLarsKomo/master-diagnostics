import {
  postgresAuthSchema,
  type Database,
  type DatabaseEngine,
} from '@masters/db';
import * as schema from '@masters/db';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth/minimal';
import { nextCookies } from 'better-auth/next-js';

export function createLocalAuth(db: Database, databaseEngine: DatabaseEngine = 'libsql') {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET must be configured with at least 32 characters.',
    );
  }

  const database = databaseEngine === 'postgres'
    ? drizzleAdapter(db, {
        provider: 'pg',
        schema: postgresAuthSchema,
      })
    : drizzleAdapter(db, {
        provider: 'sqlite',
        schema,
      });

  return betterAuth({
    appName: 'Masters Diagnostics',
    baseURL:
      process.env.NEXT_PUBLIC_APP_URL ??
      'http://localhost:3000',
    secret,

    database,

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },

    user: { modelName: 'authUsers' },
    session: { modelName: 'authSessions' },
    account: { modelName: 'authAccounts' },
    verification: { modelName: 'authVerifications' },

    plugins: [nextCookies()],
  });
}
