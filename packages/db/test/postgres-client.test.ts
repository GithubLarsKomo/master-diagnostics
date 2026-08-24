import { describe, expect, it } from 'vitest';
import { readPostgresConnectionConfig } from '../src/postgres/client';
import { readDatabaseEngine } from '../src/runtime';

describe('PostgreSQL runtime configuration', () => {
  it('accepts PostgreSQL URLs and bounded pool timeouts', () => {
    expect(readPostgresConnectionConfig({
      DATABASE_URL: 'postgresql://app:secret@postgres:5432/master_diagnostics',
      DB_POOL_MAX: '12',
      DB_IDLE_TIMEOUT_SECONDS: '30',
      DB_CONNECT_TIMEOUT_SECONDS: '15',
    })).toEqual({
      url: 'postgresql://app:secret@postgres:5432/master_diagnostics',
      poolMax: 12,
      idleTimeoutSeconds: 30,
      connectTimeoutSeconds: 15,
    });
  });

  it('uses conservative connection defaults', () => {
    expect(readPostgresConnectionConfig({
      DATABASE_URL: 'postgres://localhost/master_diagnostics',
    })).toEqual({
      url: 'postgres://localhost/master_diagnostics',
      poolMax: 10,
      idleTimeoutSeconds: 20,
      connectTimeoutSeconds: 10,
    });
  });

  it.each([
    [{}, 'DATABASE_URL is required'],
    [{ DATABASE_URL: 'file:./legacy.db' }, 'must use postgres:// or postgresql://'],
    [{ DATABASE_URL: 'https://db.example', DB_POOL_MAX: '10' }, 'must use postgres:// or postgresql://'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_POOL_MAX: '0' }, 'DB_POOL_MAX must be an integer between 1 and 100'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_POOL_MAX: '101' }, 'DB_POOL_MAX must be an integer between 1 and 100'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_POOL_MAX: '4.5' }, 'DB_POOL_MAX must be an integer between 1 and 100'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_IDLE_TIMEOUT_SECONDS: '0' }, 'DB_IDLE_TIMEOUT_SECONDS must be an integer between 1 and 600'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_CONNECT_TIMEOUT_SECONDS: '121' }, 'DB_CONNECT_TIMEOUT_SECONDS must be an integer between 1 and 120'],
  ])('rejects unsafe configuration %#', (env, message) => {
    expect(() => readPostgresConnectionConfig(env)).toThrow(message);
  });

  it('keeps libSQL as the explicit default runtime', () => {
    expect(readDatabaseEngine({})).toBe('libsql');
    expect(readDatabaseEngine({ DB_ENGINE: 'postgres' })).toBe('postgres');
    expect(() => readDatabaseEngine({ DB_ENGINE: 'mysql' })).toThrow('DB_ENGINE must be either libsql or postgres');
  });
});
