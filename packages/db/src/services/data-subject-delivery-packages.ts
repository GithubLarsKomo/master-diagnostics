import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteDataSubjectDeliveryPackages } from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export const DATA_SUBJECT_DELIVERY_PACKAGE_VERSION = 1 as const;

export interface CreateAthleteDataSubjectDeliveryPackageRecordInput {
  id: string;
  tenantId: string;
  athleteId: string;
  approvalId: string;
  manifestFingerprint: string;
  tokenHash: string;
  storageReference: string;
  packageSha256: string;
  actor: AuditActorContext;
  expiresAt: string;
  createdAt?: string;
}

export interface StoredAthleteDataSubjectDeliveryPackage {
  id: string;
  tenantId: string;
  athleteId: string;
  approvalId: string;
  packageVersion: typeof DATA_SUBJECT_DELIVERY_PACKAGE_VERSION;
  manifestFingerprint: string;
  tokenHash: string;
  storageReference: string;
  packageSha256: string;
  createdByUserId: string;
  expiresAt: string;
  downloadedAt: string | null;
  createdAt: string;
}

function stored(
  row: typeof athleteDataSubjectDeliveryPackages.$inferSelect,
): Readonly<StoredAthleteDataSubjectDeliveryPackage> {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    athleteId: row.athleteId,
    approvalId: row.approvalId,
    packageVersion: DATA_SUBJECT_DELIVERY_PACKAGE_VERSION,
    manifestFingerprint: row.manifestFingerprint,
    tokenHash: row.tokenHash,
    storageReference: row.storageReference,
    packageSha256: row.packageSha256,
    createdByUserId: row.createdByUserId,
    expiresAt: row.expiresAt,
    downloadedAt: row.downloadedAt,
    createdAt: row.createdAt,
  });
}

export async function createAthleteDataSubjectDeliveryPackageRecord(
  db: Database,
  input: CreateAthleteDataSubjectDeliveryPackageRecordInput,
): Promise<Readonly<StoredAthleteDataSubjectDeliveryPackage>> {
  if (input.actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Package creation time must be a valid ISO-8601 timestamp');
  if (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= createdAt) {
    throw new Error('Package expiry must be a valid timestamp after creation');
  }

  const row = {
    id: input.id,
    tenantId: input.tenantId,
    athleteId: input.athleteId,
    approvalId: input.approvalId,
    packageVersion: DATA_SUBJECT_DELIVERY_PACKAGE_VERSION,
    manifestFingerprint: input.manifestFingerprint,
    tokenHash: input.tokenHash,
    storageReference: input.storageReference,
    packageSha256: input.packageSha256,
    createdByUserId: input.actor.userId,
    expiresAt: input.expiresAt,
    downloadedAt: null,
    createdAt,
    updatedAt: createdAt,
  };

  await db.transaction(async (tx) => {
    await tx.insert(athleteDataSubjectDeliveryPackages).values(row);
    await appendAuditEvent(tx, {
      tenantId: input.tenantId,
      ...auditActorFields(input.actor),
      action: 'athlete.data_subject_export_created',
      entityType: 'athlete_data_subject_delivery_package',
      entityId: input.id,
      source: 'WEB',
      after: {
        packageVersion: DATA_SUBJECT_DELIVERY_PACKAGE_VERSION,
        athleteId: input.athleteId,
        approvalId: input.approvalId,
        manifestFingerprint: input.manifestFingerprint,
        packageSha256: input.packageSha256,
        expiresAt: input.expiresAt,
      },
      occurredAt: createdAt,
    });
  });

  return stored(row);
}

export async function getAthleteDataSubjectDeliveryPackage(
  db: Database,
  tenantId: string,
  athleteId: string,
  packageId: string,
): Promise<Readonly<StoredAthleteDataSubjectDeliveryPackage> | null> {
  const [row] = await db.select().from(athleteDataSubjectDeliveryPackages).where(and(
    eq(athleteDataSubjectDeliveryPackages.id, packageId),
    eq(athleteDataSubjectDeliveryPackages.tenantId, tenantId),
    eq(athleteDataSubjectDeliveryPackages.athleteId, athleteId),
  )).limit(1);
  return row ? stored(row) : null;
}

export async function getAvailableAthleteDataSubjectDeliveryPackage(
  db: Database,
  tokenHash: string,
  now = new Date().toISOString(),
): Promise<Readonly<StoredAthleteDataSubjectDeliveryPackage> | null> {
  const [row] = await db
    .select()
    .from(athleteDataSubjectDeliveryPackages)
    .where(and(
      eq(athleteDataSubjectDeliveryPackages.tokenHash, tokenHash),
      isNull(athleteDataSubjectDeliveryPackages.downloadedAt),
      gt(athleteDataSubjectDeliveryPackages.expiresAt, now),
    ))
    .limit(1);
  return row ? stored(row) : null;
}

export async function consumeAthleteDataSubjectDeliveryPackage(
  db: Database,
  tokenHash: string,
  now = new Date().toISOString(),
): Promise<Readonly<StoredAthleteDataSubjectDeliveryPackage> | null> {
  if (!Number.isFinite(Date.parse(now))) throw new Error('Download time must be a valid ISO-8601 timestamp');

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(athleteDataSubjectDeliveryPackages)
      .set({ downloadedAt: now, updatedAt: now })
      .where(and(
        eq(athleteDataSubjectDeliveryPackages.tokenHash, tokenHash),
        isNull(athleteDataSubjectDeliveryPackages.downloadedAt),
        gt(athleteDataSubjectDeliveryPackages.expiresAt, now),
      ))
      .returning();
    const row = rows[0];
    if (!row) return null;

    await appendAuditEvent(tx, {
      tenantId: row.tenantId,
      occurredAt: now,
      action: 'athlete.data_subject_export_downloaded',
      entityType: 'athlete_data_subject_delivery_package',
      entityId: row.id,
      source: 'DOWNLOAD_LINK',
      after: {
        packageVersion: row.packageVersion,
        approvalId: row.approvalId,
        manifestFingerprint: row.manifestFingerprint,
        packageSha256: row.packageSha256,
      },
    });
    return stored(row);
  });
}
