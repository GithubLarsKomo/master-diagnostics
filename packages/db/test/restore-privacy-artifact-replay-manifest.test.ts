import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  buildRestorePrivacyArtifactReplayManifest,
  persistRestorePrivacyArtifactReplayManifest,
} from '../src/services/restore-privacy-artifact-replay-manifest';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const createdAt = '2020-01-01T00:00:00.000Z';
const cutoff = '2026-08-01T00:00:00.000Z';

async function createTestDatabase(): Promise<Database> {
  const client = createClient({ url: `file:/tmp/masters-restore-artifact-plan-${crypto.randomUUID()}.db` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

function reconciliation(status: 'CLEAR' | 'REPLAY_REQUIRED' | 'BLOCKED' = 'REPLAY_REQUIRED'): RestorePrivacyReconciliationReport {
  const blocked = status === 'BLOCKED';
  const clear = status === 'CLEAR';
  return {
    reportVersion: 1,
    backupCutoff: cutoff,
    status,
    reconciliationReady: !blocked,
    promotionAllowed: false,
    ledger: blocked ? null : {
      generatedAt: '2026-08-07T00:00:00.000Z',
      entriesFingerprint: `sha256:${'c'.repeat(64)}`,
      entryCount: clear ? 0 : 1,
    },
    journalMarkerCount: clear ? 0 : 2,
    obligations: clear || blocked ? [] : [{
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      executionId: 'execution-after-backup-a',
      approvalId: 'approval-after-backup-a',
      deletionRequestId: 'deletion-after-backup-a',
      executionVersion: 1,
      policyVersion: '1.0.0',
      scopeFingerprint: `sha256:${'a'.repeat(64)}`,
      capabilityFingerprint: `sha256:${'b'.repeat(64)}`,
      dbCommittedAt: '2026-08-06T10:00:00.000Z',
      sources: ['LEDGER', 'JOURNAL'],
    }],
    blockers: blocked ? [{ code: 'TRUSTED_LEDGER_MISSING', executionId: null }] : [],
  };
}

async function seedArtifacts(db: Database): Promise<void> {
  await db.insert(schema.athletes).values([
    {
      id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Ada', lastName: 'Athlete',
      birthDate: '1985-05-05', referenceCategory: 'MASTERS', heightCm: 170, currentWeightKgX100: 6500,
      primarySport: 'ROWING', primaryDiscipline: 'SINGLE', trainingStatus: 'TRAINED',
      consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
    },
    {
      id: 'athlete-b', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Other', lastName: 'Athlete',
      birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 180, currentWeightKgX100: 8000,
      primarySport: 'ROWING', primaryDiscipline: 'SINGLE', trainingStatus: 'TRAINED',
      consentBlockedAt: null, deletedAt: null, createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.tests).values([
    {
      id: 'test-a', tenantId: 'tenant-a', athleteId: 'athlete-a', deviceType: 'ROWERG', status: 'RELEASED',
      conductingTrainerUserId: 'coach-a', scheduledAt: createdAt, startedAt: createdAt, endedAt: createdAt,
      currentVersion: 1, releasedAt: createdAt, createdAt, updatedAt: createdAt,
    },
    {
      id: 'test-b', tenantId: 'tenant-a', athleteId: 'athlete-b', deviceType: 'ROWERG', status: 'RELEASED',
      conductingTrainerUserId: 'coach-a', scheduledAt: createdAt, startedAt: createdAt, endedAt: createdAt,
      currentVersion: 1, releasedAt: createdAt, createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.interpretations).values([
    {
      id: 'interpretation-a', tenantId: 'tenant-a', testId: 'test-a', versionNumber: 1,
      lt1Json: '{}', lt2Json: '{}', rationale: null, status: 'RELEASED', releasedAt: createdAt,
      releasedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
    },
    {
      id: 'interpretation-b', tenantId: 'tenant-a', testId: 'test-b', versionNumber: 1,
      lt1Json: '{}', lt2Json: '{}', rationale: null, status: 'RELEASED', releasedAt: createdAt,
      releasedByUserId: 'coach-a', createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.reportVersions).values([
    {
      id: 'report-a', tenantId: 'tenant-a', testId: 'test-a', interpretationId: 'interpretation-a', versionNumber: 1,
      locale: 'de', contentHash: `sha256:${'d'.repeat(64)}`,
      storageReference: `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`, createdAt, updatedAt: createdAt,
    },
    {
      id: 'report-b', tenantId: 'tenant-a', testId: 'test-b', interpretationId: 'interpretation-b', versionNumber: 1,
      locale: 'de', contentHash: `sha256:${'e'.repeat(64)}`,
      storageReference: `tenant-a/test-b/de/${'e'.repeat(64)}.pdf`, createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.tenantExportPackages).values([
    {
      id: 'tenant-export-a', tenantId: 'tenant-a', tokenHash: `sha256:${'1'.repeat(64)}`,
      storageReference: '11111111-1111-1111-1111-111111111111.mde', packageSha256: `sha256:${'2'.repeat(64)}`,
      createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
      createdAt, updatedAt: createdAt,
    },
    {
      id: 'tenant-export-b', tenantId: 'tenant-b', tokenHash: `sha256:${'3'.repeat(64)}`,
      storageReference: '22222222-2222-2222-2222-222222222222.mde', packageSha256: `sha256:${'4'.repeat(64)}`,
      createdByUserId: 'admin-b', expiresAt: '2027-01-01T00:00:00.000Z', downloadedAt: null,
      createdAt, updatedAt: createdAt,
    },
  ]);
  await db.insert(schema.athleteDataSubjectDeliveryPackages).values([
    {
      id: '33333333-3333-3333-3333-333333333333', tenantId: 'tenant-a', athleteId: 'athlete-a',
      approvalId: 'delivery-approval-a', packageVersion: 1, manifestFingerprint: `sha256:${'5'.repeat(64)}`,
      tokenHash: `sha256:${'6'.repeat(64)}`, storageReference: '33333333-3333-3333-3333-333333333333.mdse',
      packageSha256: `sha256:${'7'.repeat(64)}`, createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z',
      downloadedAt: null, createdAt, updatedAt: createdAt,
    },
    {
      id: '44444444-4444-4444-4444-444444444444', tenantId: 'tenant-a', athleteId: 'athlete-b',
      approvalId: 'delivery-approval-b', packageVersion: 1, manifestFingerprint: `sha256:${'8'.repeat(64)}`,
      tokenHash: `sha256:${'9'.repeat(64)}`, storageReference: '44444444-4444-4444-4444-444444444444.mdse',
      packageSha256: `sha256:${'a'.repeat(64)}`, createdByUserId: 'admin-a', expiresAt: '2027-01-01T00:00:00.000Z',
      downloadedAt: null, createdAt, updatedAt: createdAt,
    },
  ]);
}

describe('restore privacy artifact replay manifest', () => {
  it('captures only affected reports/delivery packages and all affected-tenant exports before DB replay', async () => {
    const db = await createTestDatabase();
    await seedArtifacts(db);

    const manifest = await buildRestorePrivacyArtifactReplayManifest(db, reconciliation());

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.reconciliationStatus).toBe('REPLAY_REQUIRED');
    expect(manifest.obligationCount).toBe(1);
    expect(manifest.entryCount).toBe(3);
    expect(manifest.entriesFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.obligationsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.entries).toEqual([
      {
        kind: 'DATA_SUBJECT_DELIVERY', tenantId: 'tenant-a', athleteId: 'athlete-a',
        storageReference: '33333333-3333-3333-3333-333333333333.mdse',
        executionIds: ['execution-after-backup-a'],
      },
      {
        kind: 'REPORT', tenantId: 'tenant-a', athleteId: 'athlete-a',
        storageReference: `tenant-a/test-a/de/${'d'.repeat(64)}.pdf`,
        executionIds: ['execution-after-backup-a'],
      },
      {
        kind: 'TENANT_EXPORT', tenantId: 'tenant-a', athleteId: null,
        storageReference: '11111111-1111-1111-1111-111111111111.mde',
        executionIds: ['execution-after-backup-a'],
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain('Ada');
  });

  it('produces an empty deterministic manifest for CLEAR and refuses BLOCKED reconciliation', async () => {
    const db = await createTestDatabase();
    await seedArtifacts(db);

    const clear = await buildRestorePrivacyArtifactReplayManifest(db, reconciliation('CLEAR'));
    expect(clear.entryCount).toBe(0);
    expect(clear.entries).toEqual([]);
    expect(clear.obligationCount).toBe(0);
    await expect(buildRestorePrivacyArtifactReplayManifest(db, reconciliation('BLOCKED')))
      .rejects.toThrow(/blocked reconciliation/);
  });

  it('persists byte-identically for retries and blocks conflicting replacement', async () => {
    const db = await createTestDatabase();
    const manifest = await buildRestorePrivacyArtifactReplayManifest(db, reconciliation('CLEAR'));
    const root = await mkdtemp(join(tmpdir(), 'restore-artifact-plan-'));
    const filePath = join(root, 'private-work', 'artifact-replay-manifest.json');

    expect((await persistRestorePrivacyArtifactReplayManifest(filePath, manifest)).created).toBe(true);
    expect((await persistRestorePrivacyArtifactReplayManifest(filePath, manifest)).created).toBe(false);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'private-work'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(manifest);

    const conflicting = { ...manifest, entriesFingerprint: `sha256:${'f'.repeat(64)}` as const };
    await expect(persistRestorePrivacyArtifactReplayManifest(filePath, conflicting))
      .rejects.toThrow(/different content/);
  });
});
