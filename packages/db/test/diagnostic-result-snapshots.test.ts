import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  appendDiagnosticResultSnapshot,
  getDiagnosticResultSnapshot,
} from '../src/services/diagnostic-result-snapshots';

async function createTestDatabase(): Promise<{ db: Database; client: Client }> {
  const databasePath = `/tmp/masters-diagnostic-snapshots-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE tests (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)`,
    `CREATE TABLE diagnostic_result_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      canonicalization TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX diagnostic_result_snapshot_test_version_uq
      ON diagnostic_result_snapshots (tenant_id, test_id, version_number)`,
    `CREATE TRIGGER diagnostic_result_snapshots_immutable_update
      BEFORE UPDATE ON diagnostic_result_snapshots
      BEGIN SELECT RAISE(ABORT, 'diagnostic result snapshots are immutable'); END`,
    `CREATE TRIGGER diagnostic_result_snapshots_immutable_delete
      BEFORE DELETE ON diagnostic_result_snapshots
      BEGIN SELECT RAISE(ABORT, 'diagnostic result snapshots are immutable'); END`,
    `INSERT INTO tests (id, tenant_id) VALUES ('test-a', 'tenant-a')`,
  ]);
  return { db: drizzle(client, { schema }) as Database, client };
}

const firstEnvelope = {
  schemaVersion: 'diagnostic-result-snapshot-v1',
  canonicalization: 'diagnostic-json-v1',
  resultHash: `sha256:${'a'.repeat(64)}`,
  result: { method: 'fixed', lt2: { watts: 270, lactate: 4 } },
};

describe('diagnostic result snapshot repository', () => {
  let db: Database;
  let client: Client;

  beforeEach(async () => {
    ({ db, client } = await createTestDatabase());
  });

  it('appends immutable versions and reads latest or explicit versions', async () => {
    const first = await appendDiagnosticResultSnapshot(db, 'tenant-a', 'test-a', firstEnvelope);
    const second = await appendDiagnosticResultSnapshot(db, 'tenant-a', 'test-a', {
      ...firstEnvelope,
      resultHash: `sha256:${'b'.repeat(64)}`,
      result: { method: 'dmax', lt2: { watts: 278, lactate: 4.2 } },
    });

    expect(first.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(2);
    await expect(getDiagnosticResultSnapshot(db, 'tenant-a', 'test-a')).resolves.toMatchObject({
      versionNumber: 2,
      resultHash: `sha256:${'b'.repeat(64)}`,
    });
    await expect(getDiagnosticResultSnapshot(db, 'tenant-a', 'test-a', 1)).resolves.toMatchObject({
      versionNumber: 1,
      result: firstEnvelope.result,
    });
  });

  it('enforces tenant scope and validates the persisted envelope', async () => {
    await expect(
      appendDiagnosticResultSnapshot(db, 'tenant-b', 'test-a', firstEnvelope),
    ).rejects.toThrow('not found for tenant');
    await expect(getDiagnosticResultSnapshot(db, 'tenant-b', 'test-a')).resolves.toBeNull();
    await expect(
      appendDiagnosticResultSnapshot(db, 'tenant-a', 'test-a', {
        ...firstEnvelope,
        resultHash: 'sha256:not-a-digest',
      }),
    ).rejects.toThrow('hash is invalid');
  });

  it('blocks updates and deletes at database level', async () => {
    const stored = await appendDiagnosticResultSnapshot(db, 'tenant-a', 'test-a', firstEnvelope);

    await expect(client.execute({
      sql: 'UPDATE diagnostic_result_snapshots SET result_json = ? WHERE id = ?',
      args: ['{}', stored.id],
    })).rejects.toThrow('diagnostic result snapshots are immutable');
    await expect(client.execute({
      sql: 'DELETE FROM diagnostic_result_snapshots WHERE id = ?',
      args: [stored.id],
    })).rejects.toThrow('diagnostic result snapshots are immutable');
  });
});
