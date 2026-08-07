import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabaseFromConfig, type Database } from '../src/client';
import * as schema from '../src/schema';
import { getAthleteAnonymizationPrivacyEffectIdentity } from '../src/services/anonymization-privacy-effect';

async function createTestDatabase(): Promise<Database> {
  const db = createDatabaseFromConfig({
    url: `file:/tmp/masters-anonymization-effect-${crypto.randomUUID()}.db`,
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

const scopeFingerprint = `sha256:${'a'.repeat(64)}`;
const capabilityFingerprint = `sha256:${'b'.repeat(64)}`;

async function seed(db: Database) {
  const at = '2026-08-07T20:00:00.000Z';
  await db.insert(schema.athleteAnonymizationApprovals).values({
    id: 'approval-a',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    deletionRequestId: 'deletion-a',
    approvalVersion: 1,
    policyVersion: '1.6.0',
    assessedAt: at,
    scopeFingerprint,
    capabilityFingerprint,
    approvedByUserId: 'admin-a',
    approvedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(schema.athleteAnonymizationExecutions).values({
    id: '123e4567-e89b-42d3-a456-426614174000',
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    approvalId: 'approval-a',
    executionVersion: 1,
    status: 'ARTIFACTS_STAGED',
    preparedByUserId: 'admin-a',
    preparedAt: at,
    artifactsStagedAt: at,
    dbCommittedAt: null,
    completedAt: null,
    abortedAt: null,
    createdAt: at,
    updatedAt: at,
  });
}

describe('anonymization privacy effect identity', () => {
  it('returns the exact immutable execution/approval reconciliation identity', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const effect = await getAthleteAnonymizationPrivacyEffectIdentity(
      db, 'tenant-a', 'athlete-a', '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(effect).toEqual({
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      executionId: '123e4567-e89b-42d3-a456-426614174000',
      approvalId: 'approval-a',
      deletionRequestId: 'deletion-a',
      executionVersion: 1,
      policyVersion: '1.6.0',
      scopeFingerprint,
      capabilityFingerprint,
    });
    expect(Object.isFrozen(effect)).toBe(true);
  });

  it('fails closed across tenant, athlete and execution boundaries', async () => {
    const db = await createTestDatabase();
    await seed(db);
    expect(await getAthleteAnonymizationPrivacyEffectIdentity(
      db, 'tenant-b', 'athlete-a', '123e4567-e89b-42d3-a456-426614174000',
    )).toBeNull();
    expect(await getAthleteAnonymizationPrivacyEffectIdentity(
      db, 'tenant-a', 'athlete-b', '123e4567-e89b-42d3-a456-426614174000',
    )).toBeNull();
    expect(await getAthleteAnonymizationPrivacyEffectIdentity(
      db, 'tenant-a', 'athlete-a', '223e4567-e89b-42d3-a456-426614174000',
    )).toBeNull();
  });

  it('does not join a cross-boundary approval row', async () => {
    const db = await createTestDatabase();
    await seed(db);
    await db.update(schema.athleteAnonymizationApprovals)
      .set({ athleteId: 'athlete-other' });
    expect(await getAthleteAnonymizationPrivacyEffectIdentity(
      db, 'tenant-a', 'athlete-a', '123e4567-e89b-42d3-a456-426614174000',
    )).toBeNull();
  });
});
