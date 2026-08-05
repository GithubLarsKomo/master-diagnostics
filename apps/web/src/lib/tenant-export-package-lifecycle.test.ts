import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortAthleteAnonymizationExecution,
  approveAthleteAnonymization,
  prepareAthleteAnonymizationExecution,
  type Database,
  type GlobalPrivacyCapabilities,
} from '@masters/db';
import * as schema from '@masters/db';
import { FileSystemTenantExportPackageStorage } from './tenant-export-package-storage';
import { cleanupExpiredTenantExportPackagesWithDependencies } from './tenant-export-package-lifecycle';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTestDatabase(): Promise<Database> {
  const path = `/tmp/masters-export-cleanup-guard-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${path}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: '../../packages/db/migrations' });
  return db;
}

const actor = {
  userId: 'admin-a', role: 'TENANT_ADMIN', authProvider: 'BETTER_AUTH' as const,
  sessionId: 'admin-session-a',
};
const capabilities: GlobalPrivacyCapabilities = {
  backup: { state: 'DISABLED' }, notifications: { state: 'DISABLED' },
};

async function seed(db: Database) {
  const createdAt = '2019-01-01T00:00:00.000Z';
  const deletedAt = '2025-01-03T00:00:00.000Z';
  await db.insert(schema.tenants).values({
    id: 'tenant-a', slug: 'tenant-a', name: 'Tenant A', deploymentMode: 'CLUB',
    timezone: 'Europe/Berlin', locale: 'de', retentionYears: 1, createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.users).values({
    id: 'admin-a', email: 'admin@example.test', displayName: 'Admin', preferredLocale: 'de',
    createdAt, updatedAt: createdAt,
  });
  await db.insert(schema.athletes).values({
    id: 'athlete-a', tenantId: 'tenant-a', linkedUserId: null, firstName: 'Petra', lastName: 'Muster',
    birthDate: '1980-01-01', referenceCategory: 'MASTERS', heightCm: 175,
    currentWeightKgX100: 6900, primarySport: 'ROWING', primaryDiscipline: 'SINGLE',
    trainingStatus: 'TRAINED', consentBlockedAt: deletedAt, deletedAt, createdAt, updatedAt: deletedAt,
  });
  await db.insert(schema.athleteDeletionRequests).values({
    id: 'deletion-a', tenantId: 'tenant-a', athleteId: 'athlete-a', status: 'COMPLETED',
    reason: 'Betroffenenrecht', requestedAt: '2025-01-01T00:00:00.000Z',
    decidedAt: '2025-01-02T00:00:00.000Z', decisionReason: 'Freigegeben', completedAt: deletedAt,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: deletedAt,
  });
}

describe('tenant export cleanup anonymization guard', () => {
  it('skips expired packages while an execution owns the tenant and resumes after abort', async () => {
    const db = await createTestDatabase();
    await seed(db);
    const root = await mkdtemp(join(tmpdir(), 'masters-export-cleanup-guard-'));
    roots.push(root);
    const storage = new FileSystemTenantExportPackageStorage(root);
    const reference = '01234567-89ab-cdef-0123-456789abcdef.mde';
    await storage.put(reference, new TextEncoder().encode('expired-export'));
    await db.insert(schema.tenantExportPackages).values({
      id: 'export-expired', tenantId: 'tenant-a', tokenHash: `sha256:${'a'.repeat(64)}`,
      storageReference: reference, packageSha256: `sha256:${'b'.repeat(64)}`,
      createdByUserId: 'admin-a', expiresAt: '2026-08-05T12:00:00.000Z', downloadedAt: null,
      createdAt: '2026-08-05T11:00:00.000Z', updatedAt: '2026-08-05T11:00:00.000Z',
    });

    const approval = await approveAthleteAnonymization(
      db, 'tenant-a', 'athlete-a', actor, capabilities, '2026-08-05T13:00:00.000Z',
    );
    const execution = await prepareAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', approval.id, actor, capabilities, '2026-08-05T13:01:00.000Z',
    );

    expect(await cleanupExpiredTenantExportPackagesWithDependencies(
      db, storage, '2026-08-05T13:02:00.000Z',
    )).toBe(0);
    expect(await db.select().from(schema.tenantExportPackages)).toHaveLength(1);
    expect(new TextDecoder().decode(await storage.get(reference))).toBe('expired-export');

    await abortAthleteAnonymizationExecution(
      db, 'tenant-a', 'athlete-a', execution.id, actor, '2026-08-05T13:03:00.000Z',
    );
    expect(await cleanupExpiredTenantExportPackagesWithDependencies(
      db, storage, '2026-08-05T13:04:00.000Z',
    )).toBe(1);
    expect(await db.select().from(schema.tenantExportPackages)).toEqual([]);
    await expect(storage.get(reference)).rejects.toThrow();
  });
});
