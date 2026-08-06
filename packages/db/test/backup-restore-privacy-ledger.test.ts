import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { buildRestorePrivacyReconciliationLedger } from '../src/services/backup-restore-privacy-ledger';

async function createTestDatabase(): Promise<{ db: Database; client: ReturnType<typeof createClient> }> {
  const client = createClient({ url: `file:/tmp/masters-restore-ledger-${crypto.randomUUID()}.db` });
  await client.execute(`CREATE TABLE athlete_anonymization_executions (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    athlete_id TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    execution_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    prepared_by_user_id TEXT NOT NULL,
    prepared_at TEXT NOT NULL,
    artifacts_staged_at TEXT,
    db_committed_at TEXT,
    completed_at TEXT,
    aborted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  return { db: drizzle(client, { schema }) as Database, client };
}

async function insertExecution(
  client: ReturnType<typeof createClient>,
  input: {
    id: string;
    tenantId: string;
    athleteId: string;
    status: 'PREPARING' | 'ARTIFACTS_STAGED' | 'DB_COMMITTED' | 'COMPLETED' | 'ABORTED';
    dbCommittedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  const preparedAt = '2026-08-01T00:00:00.000Z';
  await client.execute({
    sql: `INSERT INTO athlete_anonymization_executions (
      id, tenant_id, athlete_id, approval_id, execution_version, status,
      prepared_by_user_id, prepared_at, artifacts_staged_at, db_committed_at,
      completed_at, aborted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'admin-a', ?, NULL, ?, ?, NULL, ?, ?)`,
    args: [
      input.id,
      input.tenantId,
      input.athleteId,
      `approval-${input.id}`,
      input.status,
      preparedAt,
      input.dbCommittedAt ?? null,
      input.completedAt ?? null,
      preparedAt,
      input.completedAt ?? input.dbCommittedAt ?? preparedAt,
    ],
  });
}

describe('restore privacy reconciliation ledger', () => {
  it('includes every privacy-effective execution after the backup, including DB_COMMITTED recovery state', async () => {
    const { db, client } = await createTestDatabase();
    const backupCreatedAt = '2026-08-02T00:00:00.000Z';
    const generatedAt = '2026-08-06T00:00:00.000Z';

    await insertExecution(client, {
      id: 'before-backup', tenantId: 'tenant-a', athleteId: 'athlete-old', status: 'COMPLETED',
      dbCommittedAt: '2026-08-01T20:00:00.000Z', completedAt: '2026-08-01T20:01:00.000Z',
    });
    await insertExecution(client, {
      id: 'committed-recovery', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'DB_COMMITTED',
      dbCommittedAt: '2026-08-03T10:00:00.000Z',
    });
    await insertExecution(client, {
      id: 'completed', tenantId: 'tenant-b', athleteId: 'athlete-b', status: 'COMPLETED',
      dbCommittedAt: '2026-08-04T10:00:00.000Z', completedAt: '2026-08-04T10:05:00.000Z',
    });
    await insertExecution(client, {
      id: 'preparing', tenantId: 'tenant-a', athleteId: 'athlete-c', status: 'PREPARING',
    });
    await insertExecution(client, {
      id: 'future', tenantId: 'tenant-a', athleteId: 'athlete-future', status: 'COMPLETED',
      dbCommittedAt: '2026-08-07T10:00:00.000Z', completedAt: '2026-08-07T10:01:00.000Z',
    });

    const ledger = await buildRestorePrivacyReconciliationLedger(db, backupCreatedAt, generatedAt);
    expect(ledger.entryCount).toBe(2);
    expect(ledger.entries).toEqual([
      {
        tenantId: 'tenant-a', athleteId: 'athlete-a', executionId: 'committed-recovery',
        dbCommittedAt: '2026-08-03T10:00:00.000Z', executionStatus: 'DB_COMMITTED',
      },
      {
        tenantId: 'tenant-b', athleteId: 'athlete-b', executionId: 'completed',
        dbCommittedAt: '2026-08-04T10:00:00.000Z', executionStatus: 'COMPLETED',
      },
    ]);
    expect(ledger.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain('admin-a');
  });

  it('is deterministic for the same observation window and rejects invalid windows', async () => {
    const { db, client } = await createTestDatabase();
    await insertExecution(client, {
      id: 'completed', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
      dbCommittedAt: '2026-08-04T10:00:00.000Z', completedAt: '2026-08-04T10:05:00.000Z',
    });
    const first = await buildRestorePrivacyReconciliationLedger(
      db, '2026-08-02T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
    );
    const second = await buildRestorePrivacyReconciliationLedger(
      db, '2026-08-02T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
    );
    expect(second).toEqual(first);
    await expect(buildRestorePrivacyReconciliationLedger(db, 'not-a-date')).rejects.toThrow('Backup creation time');
    await expect(buildRestorePrivacyReconciliationLedger(
      db, '2026-08-06T00:00:00.000Z', '2026-08-05T00:00:00.000Z',
    )).rejects.toThrow('cannot precede');
  });
});
