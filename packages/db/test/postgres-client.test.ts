import { describe, expect, it, vi } from 'vitest';
import {
  createPostgresDatabaseFromExecutor,
  readPostgresConnectionConfig,
} from '../src/postgres/client';

describe('PostgreSQL provider boundary', () => {
  it('accepts PostgreSQL URLs and a bounded pool size', () => {
    expect(readPostgresConnectionConfig({
      DATABASE_URL: 'postgresql://app:secret@postgres:5432/master_diagnostics',
      DB_POOL_MAX: '12',
    })).toEqual({
      url: 'postgresql://app:secret@postgres:5432/master_diagnostics',
      poolMax: 12,
    });
  });

  it('defaults the pool size to 10', () => {
    expect(readPostgresConnectionConfig({
      DATABASE_URL: 'postgres://localhost/master_diagnostics',
    }).poolMax).toBe(10);
  });

  it.each([
    [{}, 'DATABASE_URL is required'],
    [{ DATABASE_URL: 'file:./legacy.db' }, 'must use postgres:// or postgresql://'],
    [{ DATABASE_URL: 'https://db.example', DB_POOL_MAX: '10' }, 'must use postgres:// or postgresql://'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_POOL_MAX: '0' }, 'between 1 and 100'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_POOL_MAX: '101' }, 'between 1 and 100'],
    [{ DATABASE_URL: 'postgres://localhost/db', DB_POOL_MAX: '4.5' }, 'between 1 and 100'],
  ])('rejects unsafe configuration %#', (env, message) => {
    expect(() => readPostgresConnectionConfig(env)).toThrow(message);
  });

  it('constructs a Drizzle database around an injected executor', async () => {
    const executor = vi.fn(async () => ({ rows: [[1]] }));
    const db = createPostgresDatabaseFromExecutor(executor);

    expect(db).toBeDefined();
    expect(executor).not.toHaveBeenCalled();
  });
});
