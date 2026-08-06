import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { auditTestArtifactDelivery } from '../src/services/test-artifact-delivery-audit';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-test-artifact-audit-${crypto.randomUUID()}.db` });
  await client.execute(`CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor_user_id TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    source TEXT NOT NULL,
    reason TEXT,
    before_json TEXT,
    after_json TEXT,
    correlation_id TEXT NOT NULL,
    auth_provider TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  return drizzle(client, { schema }) as Database;
}

const actor = {
  userId: 'trainer-a',
  role: 'TRAINER',
  authProvider: 'BETTER_AUTH',
  sessionId: 'session-a',
} as const;

const reportHash = `sha256:${'a'.repeat(64)}`;

describe('test artifact delivery audit', () => {
  it('records the three allowed delivery categories with minimized payloads', async () => {
    const db = await createTestDatabase();
    const occurredAt = '2026-08-06T03:00:00.000Z';

    await auditTestArtifactDelivery(db, 'tenant-a', 'test-a', actor, {
      kind: 'TEST_EXPORT',
      format: 'csv',
    }, occurredAt);
    await auditTestArtifactDelivery(db, 'tenant-a', 'test-a', actor, {
      kind: 'ANALYSIS_EXPORT',
      riskLevel: 'LOW',
      equivalenceClassSize: 8,
    }, occurredAt);
    await auditTestArtifactDelivery(db, 'tenant-a', 'test-a', actor, {
      kind: 'REPORT',
      reportVersionId: 'report-v1',
      locale: 'de',
      versionNumber: 1,
      contentHash: reportHash,
    }, occurredAt);

    const rows = await db.select().from(schema.auditEvents);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.action).sort()).toEqual([
      'analysis.export_downloaded',
      'report.downloaded',
      'test.export_downloaded',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        tenantId: 'tenant-a',
        actorUserId: 'trainer-a',
        actorRole: 'TRAINER',
        authProvider: 'BETTER_AUTH',
        sessionId: 'session-a',
        source: 'WEB',
        occurredAt,
      });
      expect(row.afterJson).not.toContain('athlete');
      expect(row.afterJson).not.toContain('storage');
    }

    const report = rows.find((row) => row.action === 'report.downloaded');
    expect(report).toMatchObject({ entityType: 'report_version', entityId: 'report-v1' });
    expect(JSON.parse(report?.afterJson ?? '{}')).toEqual({
      testId: 'test-a',
      locale: 'de',
      versionNumber: 1,
      contentHash: reportHash,
    });

    const analysis = rows.find((row) => row.action === 'analysis.export_downloaded');
    expect(JSON.parse(analysis?.afterJson ?? '{}')).toEqual({
      riskLevel: 'LOW',
      equivalenceClassSize: 8,
    });
  });

  it('rejects invalid report and analysis metadata before writing audit rows', async () => {
    const db = await createTestDatabase();
    await expect(auditTestArtifactDelivery(db, 'tenant-a', 'test-a', actor, {
      kind: 'ANALYSIS_EXPORT',
      riskLevel: 'LOW',
      equivalenceClassSize: 0,
    })).rejects.toThrow('positive integer');
    await expect(auditTestArtifactDelivery(db, 'tenant-a', 'test-a', actor, {
      kind: 'REPORT',
      reportVersionId: 'report-v1',
      locale: 'de',
      versionNumber: 1,
      contentHash: 'bad',
    })).rejects.toThrow('content hash');

    expect(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, 'tenant-a'))).toHaveLength(0);
  });
});
