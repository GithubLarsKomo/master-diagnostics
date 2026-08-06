import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabaseFromConfig, type Database } from '../src/client';
import * as schema from '../src/schema';
import { getRestorePrivacyReconciliationLedger } from '../src/services/restore-privacy-ledger';

async function createTestDatabase(): Promise<Database> {
  const db = createDatabaseFromConfig({
    url: `file:/tmp/masters-restore-privacy-ledger-${crypto.randomUUID()}.db`,
  });
  await db.run(sql.raw(`CREATE TABLE athlete_anonymization_approvals (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    athlete_id TEXT NOT NULL,
    deletion_request_id TEXT NOT NULL,
    approval_version INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    assessed_at TEXT NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    capability_fingerprint TEXT NOT NULL,
    approved_by_user_id TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`));
  await db.run(sql.raw(`CREATE TABLE athlete_anonymization_executions (
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
  )`));
  return db;
}

const scopeA = `sha256:${'a'.repeat(64)}`;
const capA = `sha256:${'b'.repeat(64)}`;
const scopeB = `sha256:${'c'.repeat(64)}`;
const capB = `sha256:${'d'.repeat(64)}`;

async function seedApproval(
  db: Database,
  id: string,
  tenantId: string,
  athleteId: string,
  policyVersion: string,
  scopeFingerprint: string,
  capabilityFingerprint: string,
) {
  const at = '2026-08-01T00:00:00.000Z';
  await db.insert(schema.athleteAnonymizationApprovals).values({
    id,
    tenantId,
    athleteId,
    deletionRequestId: `deletion-${id}`,
    approvalVersion: 1,
    policyVersion,
    assessedAt: at,
    scopeFingerprint,
    capabilityFingerprint,
    approvedByUserId: 'admin-a',
    approvedAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

async function seedExecution(
  db: Database,
  input: {
    id: string;
    tenantId: string;
    athleteId: string;
    approvalId: string;
    status: 'COMPLETED' | 'ABORTED';
    completedAt?: string;
  },
) {
  const preparedAt = '2026-08-01T00:00:00.000Z';
  await db.insert(schema.athleteAnonymizationExecutions).values({
    id: input.id,
    tenantId: input.tenantId,
    athleteId: input.athleteId,
    approvalId: input.approvalId,
    executionVersion: 1,
    status: input.status,
    preparedByUserId: 'admin-a',
    preparedAt,
    artifactsStagedAt: input.status === 'COMPLETED' ? preparedAt : null,
    dbCommittedAt: input.status === 'COMPLETED' ? preparedAt : null,
    completedAt: input.completedAt ?? null,
    abortedAt: input.status === 'ABORTED' ? preparedAt : null,
    createdAt: preparedAt,
    updatedAt: input.completedAt ?? preparedAt,
  });
}

describe('restore privacy reconciliation ledger', () => {
  it('returns only completed anonymizations after the selected backup cutoff in deterministic order', async () => {
    const db = await createTestDatabase();
    await seedApproval(db, 'approval-a', 'tenant-b', 'athlete-b', '1.6.0', scopeA, capA);
    await seedApproval(db, 'approval-b', 'tenant-a', 'athlete-a', '1.6.0', scopeB, capB);
    await seedApproval(db, 'approval-old', 'tenant-a', 'athlete-old', '1.5.0', scopeA, capA);
    await seedApproval(db, 'approval-aborted', 'tenant-a', 'athlete-x', '1.6.0', scopeA, capA);

    await seedExecution(db, {
      id: 'execution-b', tenantId: 'tenant-b', athleteId: 'athlete-b', approvalId: 'approval-a',
      status: 'COMPLETED', completedAt: '2026-08-03T10:00:00.000Z',
    });
    await seedExecution(db, {
      id: 'execution-a', tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: 'approval-b',
      status: 'COMPLETED', completedAt: '2026-08-03T10:00:00.000Z',
    });
    await seedExecution(db, {
      id: 'execution-old', tenantId: 'tenant-a', athleteId: 'athlete-old', approvalId: 'approval-old',
      status: 'COMPLETED', completedAt: '2026-08-02T00:00:00.000Z',
    });
    await seedExecution(db, {
      id: 'execution-aborted', tenantId: 'tenant-a', athleteId: 'athlete-x', approvalId: 'approval-aborted',
      status: 'ABORTED',
    });

    const ledger = await getRestorePrivacyReconciliationLedger(
      db,
      '2026-08-02T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    );

    expect(ledger.entries.map((entry) => entry.executionId)).toEqual(['execution-a', 'execution-b']);
    expect(ledger.entries[0]).toMatchObject({
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      approvalId: 'approval-b',
      deletionRequestId: 'deletion-approval-b',
      policyVersion: '1.6.0',
      scopeFingerprint: scopeB,
      capabilityFingerprint: capB,
    });
    expect(ledger.entriesFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps the content fingerprint stable across generation times and excludes direct PII fields', async () => {
    const db = await createTestDatabase();
    await seedApproval(db, 'approval-a', 'tenant-a', 'athlete-a', '1.6.0', scopeA, capA);
    await seedExecution(db, {
      id: 'execution-a', tenantId: 'tenant-a', athleteId: 'athlete-a', approvalId: 'approval-a',
      status: 'COMPLETED', completedAt: '2026-08-03T10:00:00.000Z',
    });

    const first = await getRestorePrivacyReconciliationLedger(
      db, '2026-08-02T00:00:00.000Z', '2026-08-04T00:00:00.000Z',
    );
    const second = await getRestorePrivacyReconciliationLedger(
      db, '2026-08-02T00:00:00.000Z', '2026-08-05T00:00:00.000Z',
    );

    expect(first.entriesFingerprint).toBe(second.entriesFingerprint);
    const serialized = JSON.stringify(first);
    for (const forbidden of ['firstName', 'lastName', 'birthDate', 'email', 'phone', 'reason']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0])).toBe(true);
  });

  it('rejects invalid or temporally impossible cutoffs', async () => {
    const db = await createTestDatabase();
    await expect(getRestorePrivacyReconciliationLedger(db, 'not-a-date'))
      .rejects.toThrow('cutoff');
    await expect(getRestorePrivacyReconciliationLedger(
      db, '2026-08-04T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('must not precede');
  });
});
