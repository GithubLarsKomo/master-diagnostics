import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  restorePrivacyArtifactReplayResultForManifest,
} from '../src/services/restore-privacy-artifact-replay';
import {
  buildRestorePrivacyArtifactReplayManifest,
} from '../src/services/restore-privacy-artifact-replay-manifest';
import {
  ensureSignedRestorePrivatePromotionIntent,
  readVerifiedRestorePrivatePromotionIntent,
  RESTORE_PRIVATE_PROMOTION_INTENT_FILE_NAME,
} from '../src/services/restore-private-promotion-intent';
import {
  assessRestorePrivatePromotionReadiness,
  type RestorePrivatePromotionReadinessReport,
} from '../src/services/restore-private-promotion-readiness';
import type { RestorePrivacyReconciliationReport } from '../src/services/restore-privacy-reconciliation-report';

const cutoff = '2026-08-01T00:00:00.000Z';
const authorizedAt = '2026-08-08T12:00:00.000Z';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-restore-promotion-intent-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  const db = drizzle(client, { schema }) as Database;
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

function reconciliation(): Readonly<RestorePrivacyReconciliationReport> {
  return Object.freeze({
    reportVersion: 1,
    backupCutoff: cutoff,
    status: 'CLEAR',
    reconciliationReady: true,
    promotionAllowed: false,
    ledger: Object.freeze({
      generatedAt: '2026-08-08T00:00:00.000Z',
      entriesFingerprint: `sha256:${'c'.repeat(64)}`,
      entryCount: 0,
    }),
    journalMarkerCount: 0,
    obligations: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

async function readinessFixture() {
  const db = await createTestDatabase();
  const workspace = await mkdtemp(join(tmpdir(), 'restore-promotion-intent-'));
  const roots = {
    reportRoot: join(workspace, 'reports'),
    tenantExportRoot: join(workspace, 'tenant-exports'),
    dataSubjectDeliveryRoot: join(workspace, 'data-subject-delivery'),
  };
  await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
  const rec = reconciliation();
  const manifest = await buildRestorePrivacyArtifactReplayManifest(db, rec);
  const result = restorePrivacyArtifactReplayResultForManifest(manifest);
  const readiness = await assessRestorePrivatePromotionReadiness(
    db,
    rec,
    manifest,
    result,
    roots,
    { plan: null, intentFile: null, receiptFile: null, keyFile: null },
  );
  const keyFile = join(workspace, 'promotion.key');
  await writeFile(keyFile, `${Buffer.alloc(32, 53).toString('base64')}\n`, { mode: 0o600 });
  return {
    workspace,
    targetDir: join(workspace, 'promotion'),
    keyFile,
    readiness,
  };
}

describe('restore private promotion intent', () => {
  it('persists a signed immutable authorization and reuses its original authorizedAt on retry', async () => {
    const fixture = await readinessFixture();
    expect(fixture.readiness).toMatchObject({
      status: 'PROMOTION_READY',
      promotionAllowed: true,
      authorizationPersisted: false,
      recoveryEvidenceStatus: 'NOT_REQUIRED',
    });

    const first = await ensureSignedRestorePrivatePromotionIntent({
      targetDir: fixture.targetDir,
      keyFile: fixture.keyFile,
      readiness: fixture.readiness,
      authorizedAt,
    });
    expect(first.created).toBe(true);
    expect(first.envelope.record).toMatchObject({
      intentVersion: 1,
      phase: 'AUTHORIZED',
      authorizedAt,
      backupCutoff: cutoff,
      readinessVersion: 1,
      readinessEvidenceFingerprint: fixture.readiness.evidenceFingerprint,
      healthcheckFingerprint: fixture.readiness.healthcheckFingerprint,
      obligationsFingerprint: fixture.readiness.obligationsFingerprint,
      artifactEntriesFingerprint: fixture.readiness.artifactEntriesFingerprint,
      recoveryEvidenceStatus: 'NOT_REQUIRED',
      authorizationScope: 'PRIVATE_RESTORE_PROMOTION',
      sourceAuthorizationPersisted: false,
      promotionExecuted: false,
    });
    expect(first.envelope.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect((await stat(fixture.targetDir)).mode & 0o777).toBe(0o700);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    const second = await ensureSignedRestorePrivatePromotionIntent({
      targetDir: fixture.targetDir,
      keyFile: fixture.keyFile,
      readiness: fixture.readiness,
      authorizedAt: '2026-08-08T13:00:00.000Z',
    });
    expect(second.created).toBe(false);
    expect(second.envelope.record.authorizedAt).toBe(authorizedAt);
    expect(second.envelope).toEqual(first.envelope);
    expect(await readVerifiedRestorePrivatePromotionIntent(
      first.path,
      fixture.keyFile,
      fixture.readiness,
    )).toEqual(first.envelope);
  });

  it('rejects blocked or already-persisted readiness instead of turning it into an authorization', async () => {
    const fixture = await readinessFixture();
    const blocked = {
      ...fixture.readiness,
      status: 'BLOCKED',
      promotionAllowed: false,
      blockers: Object.freeze([{ code: 'HEALTHCHECK_NOT_HEALTHY', executionId: null }]),
    } as unknown as Readonly<RestorePrivatePromotionReadinessReport>;
    await expect(ensureSignedRestorePrivatePromotionIntent({
      targetDir: fixture.targetDir,
      keyFile: fixture.keyFile,
      readiness: blocked,
      authorizedAt,
    })).rejects.toThrow('requires an unblocked non-durable PROMOTION_READY assessment');

    const alreadyPersisted = {
      ...fixture.readiness,
      authorizationPersisted: true,
    } as unknown as Readonly<RestorePrivatePromotionReadinessReport>;
    await expect(ensureSignedRestorePrivatePromotionIntent({
      targetDir: fixture.targetDir,
      keyFile: fixture.keyFile,
      readiness: alreadyPersisted,
      authorizedAt,
    })).rejects.toThrow('requires an unblocked non-durable PROMOTION_READY assessment');
  });

  it('detects file tampering and refuses to reuse an intent for changed readiness evidence', async () => {
    const fixture = await readinessFixture();
    const created = await ensureSignedRestorePrivatePromotionIntent({
      targetDir: fixture.targetDir,
      keyFile: fixture.keyFile,
      readiness: fixture.readiness,
      authorizedAt,
    });

    const changedReadiness = {
      ...fixture.readiness,
      evidenceFingerprint: `sha256:${'e'.repeat(64)}`,
    } as Readonly<RestorePrivatePromotionReadinessReport>;
    await expect(readVerifiedRestorePrivatePromotionIntent(
      created.path,
      fixture.keyFile,
      changedReadiness,
    )).rejects.toThrow('does not match its promotion readiness evidence');

    const parsed = JSON.parse(await readFile(created.path, 'utf8')) as {
      record: { authorizedAt: string };
      signature: string;
    };
    parsed.record.authorizedAt = '2026-08-08T14:00:00.000Z';
    await writeFile(created.path, `${JSON.stringify(parsed, null, 2)}\n`);
    await expect(readVerifiedRestorePrivatePromotionIntent(
      created.path,
      fixture.keyFile,
      fixture.readiness,
    )).rejects.toThrow('signature verification failed');
  });

  it('does not allow authorization to predate verified recovery completion', async () => {
    const fixture = await readinessFixture();
    const verifiedRecoveryReadiness = {
      ...fixture.readiness,
      recoveryEvidenceStatus: 'VERIFIED',
      recoveryPlanFingerprint: `sha256:${'a'.repeat(64)}`,
      recoveryIntentSignature: `hmac-sha256:${'b'.repeat(64)}`,
      recoveryReceiptSignature: `hmac-sha256:${'d'.repeat(64)}`,
      recoveryCompletedAt: '2026-08-08T12:30:00.000Z',
      evidenceFingerprint: `sha256:${'f'.repeat(64)}`,
    } as Readonly<RestorePrivatePromotionReadinessReport>;

    await expect(ensureSignedRestorePrivatePromotionIntent({
      targetDir: fixture.targetDir,
      keyFile: fixture.keyFile,
      readiness: verifiedRecoveryReadiness,
      authorizedAt: '2026-08-08T12:00:00.000Z',
    })).rejects.toThrow('authorization must not precede recovery completion');
  });
});
