import {
  DATA_SUBJECT_DELIVERY_POLICY_VERSION,
  DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
  projectAthleteDataSubjectExportForDelivery,
  type AthleteDataSubjectDeliveryProjection,
  type AthleteDataSubjectExportSource,
  type DataSubjectDeliveryReviewDecisionInput,
  type DataSubjectDeliveryReviewItem,
} from '@masters/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteDataSubjectDeliveryApprovals } from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import { getAthleteDataSubjectExportSource } from './data-subject-export';

export const DATA_SUBJECT_DELIVERY_APPROVAL_VERSION = 1 as const;
export type DataSubjectDeliveryApprovalFingerprint = `sha256:${string}`;

export interface StoredAthleteDataSubjectDeliveryApproval {
  id: string;
  tenantId: string;
  athleteId: string;
  approvalVersion: typeof DATA_SUBJECT_DELIVERY_APPROVAL_VERSION;
  sourceSchemaVersion: typeof DATA_SUBJECT_EXPORT_SCHEMA_VERSION;
  deliveryPolicyVersion: typeof DATA_SUBJECT_DELIVERY_POLICY_VERSION;
  assessedAt: string;
  sourceFingerprint: DataSubjectDeliveryApprovalFingerprint;
  decisionsFingerprint: DataSubjectDeliveryApprovalFingerprint;
  reviewDecisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[];
  approvedByUserId: string;
  approvedAt: string;
}

export type DataSubjectDeliveryApprovalValidationBlocker =
  | 'APPROVAL_NOT_FOUND'
  | 'CONTRACT_VERSION_CHANGED'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_FINGERPRINT_CHANGED'
  | 'REVIEW_ITEMS_CHANGED'
  | 'DECISIONS_FINGERPRINT_CHANGED';

export interface AthleteDataSubjectDeliveryApprovalValidation {
  validForDeliveryPackaging: boolean;
  validatedAt: string;
  approvalId: string;
  blockers: readonly DataSubjectDeliveryApprovalValidationBlocker[];
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprint values require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported fingerprint value type: ${typeof value}`);
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(value: unknown): Promise<DataSubjectDeliveryApprovalFingerprint> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 hashing requires the Web Crypto API');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(value)));
  return `sha256:${toHex(digest)}`;
}

function reviewKey(item: Pick<DataSubjectDeliveryReviewItem, 'section' | 'rowId' | 'field'>): string {
  return `${item.section}\u0000${item.rowId}\u0000${item.field}`;
}

function normalizedReviewItems(projection: Readonly<AthleteDataSubjectDeliveryProjection>) {
  return [...projection.reviewItems]
    .map((item) => ({ section: item.section, rowId: item.rowId, field: item.field, reason: item.reason }))
    .sort((left, right) => reviewKey(left).localeCompare(reviewKey(right)));
}

function normalizeAndValidateDecisions(
  projection: Readonly<AthleteDataSubjectDeliveryProjection>,
  decisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[],
): readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[] {
  const expectedKeys = new Set(projection.reviewItems.map(reviewKey));
  const seen = new Set<string>();
  const normalized = decisions.map((decision) => {
    if (decision.decision !== 'INCLUDE_ORIGINAL' && decision.decision !== 'REDACT') {
      throw new Error('Unsupported data subject delivery review decision');
    }
    const key = reviewKey(decision);
    if (seen.has(key)) throw new Error('Duplicate data subject delivery review decision');
    seen.add(key);
    if (!expectedKeys.has(key)) throw new Error('Review decisions must exactly cover current review items');
    return Object.freeze({
      section: decision.section,
      rowId: decision.rowId,
      field: decision.field,
      decision: decision.decision,
    });
  }).sort((left, right) => reviewKey(left).localeCompare(reviewKey(right)));

  if (seen.size !== expectedKeys.size || [...expectedKeys].some((key) => !seen.has(key))) {
    throw new Error('Review decisions must exactly cover current review items');
  }
  return Object.freeze(normalized);
}

function parseStoredDecisions(value: string): readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Stored data subject review decisions must be an array');
  return Object.freeze(parsed.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid stored data subject review decision');
    const record = item as Record<string, unknown>;
    if (typeof record.section !== 'string'
      || typeof record.rowId !== 'string'
      || typeof record.field !== 'string'
      || (record.decision !== 'INCLUDE_ORIGINAL' && record.decision !== 'REDACT')) {
      throw new Error('Invalid stored data subject review decision');
    }
    return Object.freeze({
      section: record.section as DataSubjectDeliveryReviewDecisionInput['section'],
      rowId: record.rowId,
      field: record.field,
      decision: record.decision,
    });
  }));
}

async function createSourceFingerprint(
  source: Readonly<AthleteDataSubjectExportSource>,
  projection: Readonly<AthleteDataSubjectDeliveryProjection>,
): Promise<DataSubjectDeliveryApprovalFingerprint> {
  const automaticRedactions = [...projection.automaticRedactions]
    .map((item) => ({ section: item.section, rowId: item.rowId, field: item.field, reason: item.reason }))
    .sort((left, right) => reviewKey(left).localeCompare(reviewKey(right)));
  return fingerprint({
    contract: 'athlete-data-subject-delivery-source-v1',
    sourceSchemaVersion: DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
    deliveryPolicyVersion: DATA_SUBJECT_DELIVERY_POLICY_VERSION,
    tenantId: source.tenantId,
    athleteId: source.athleteId,
    data: source.data,
    reportArtifacts: source.reportArtifacts,
    automaticRedactions,
    reviewItems: normalizedReviewItems(projection),
  });
}

async function createDecisionsFingerprint(
  decisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[],
): Promise<DataSubjectDeliveryApprovalFingerprint> {
  return fingerprint({
    contract: 'athlete-data-subject-delivery-review-decisions-v1',
    decisions,
  });
}

function stored(
  row: typeof athleteDataSubjectDeliveryApprovals.$inferSelect,
): Readonly<StoredAthleteDataSubjectDeliveryApproval> {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    athleteId: row.athleteId,
    approvalVersion: DATA_SUBJECT_DELIVERY_APPROVAL_VERSION,
    sourceSchemaVersion: DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
    deliveryPolicyVersion: DATA_SUBJECT_DELIVERY_POLICY_VERSION,
    assessedAt: row.assessedAt,
    sourceFingerprint: row.sourceFingerprint as DataSubjectDeliveryApprovalFingerprint,
    decisionsFingerprint: row.decisionsFingerprint as DataSubjectDeliveryApprovalFingerprint,
    reviewDecisions: parseStoredDecisions(row.reviewDecisionsJson),
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
  });
}

export async function getAthleteDataSubjectDeliveryApproval(
  db: Database,
  tenantId: string,
  athleteId: string,
  approvalId: string,
): Promise<Readonly<StoredAthleteDataSubjectDeliveryApproval> | null> {
  const [row] = await db.select().from(athleteDataSubjectDeliveryApprovals).where(and(
    eq(athleteDataSubjectDeliveryApprovals.id, approvalId),
    eq(athleteDataSubjectDeliveryApprovals.tenantId, tenantId),
    eq(athleteDataSubjectDeliveryApprovals.athleteId, athleteId),
  )).limit(1);
  return row ? stored(row) : null;
}

/**
 * Stores a PII-free, immutable Tenant-Admin review decision for exactly the
 * current subject-data source and delivery policy. Raw reviewed free text is
 * never copied into this approval; INCLUDE_ORIGINAL only records the explicit
 * administrative decision and remains valid solely while the source hash is unchanged.
 */
export async function approveAthleteDataSubjectDeliveryReview(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: AuditActorContext,
  decisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[],
  assessedAt = new Date().toISOString(),
): Promise<Readonly<StoredAthleteDataSubjectDeliveryApproval>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  if (!Number.isFinite(Date.parse(assessedAt))) throw new Error('Assessment time must be a valid ISO-8601 timestamp');

  const source = await getAthleteDataSubjectExportSource(db, tenantId, athleteId);
  if (!source) throw new Error('Athlete data subject export source not found');
  const projection = projectAthleteDataSubjectExportForDelivery(source);
  const normalizedDecisions = normalizeAndValidateDecisions(projection, decisions);
  const [sourceFingerprint, decisionsFingerprint] = await Promise.all([
    createSourceFingerprint(source, projection),
    createDecisionsFingerprint(normalizedDecisions),
  ]);

  const [existing] = await db.select().from(athleteDataSubjectDeliveryApprovals).where(and(
    eq(athleteDataSubjectDeliveryApprovals.tenantId, tenantId),
    eq(athleteDataSubjectDeliveryApprovals.athleteId, athleteId),
    eq(athleteDataSubjectDeliveryApprovals.sourceFingerprint, sourceFingerprint),
    eq(athleteDataSubjectDeliveryApprovals.decisionsFingerprint, decisionsFingerprint),
    eq(athleteDataSubjectDeliveryApprovals.approvedByUserId, actor.userId),
  )).limit(1);
  if (existing) return stored(existing);

  const approvedAt = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    athleteId,
    approvalVersion: DATA_SUBJECT_DELIVERY_APPROVAL_VERSION,
    sourceSchemaVersion: DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
    deliveryPolicyVersion: DATA_SUBJECT_DELIVERY_POLICY_VERSION,
    assessedAt,
    sourceFingerprint,
    decisionsFingerprint,
    reviewDecisionsJson: JSON.stringify(normalizedDecisions),
    approvedByUserId: actor.userId,
    approvedAt,
    createdAt: approvedAt,
    updatedAt: approvedAt,
  };

  const includeOriginalCount = normalizedDecisions.filter((item) => item.decision === 'INCLUDE_ORIGINAL').length;
  const redactCount = normalizedDecisions.length - includeOriginalCount;
  await db.transaction(async (tx) => {
    await tx.insert(athleteDataSubjectDeliveryApprovals).values(row);
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.data_subject_delivery_review_approved',
      entityType: 'athlete_data_subject_delivery_approval',
      entityId: row.id,
      source: 'WEB',
      after: {
        approvalVersion: row.approvalVersion,
        sourceSchemaVersion: row.sourceSchemaVersion,
        deliveryPolicyVersion: row.deliveryPolicyVersion,
        athleteId,
        assessedAt,
        sourceFingerprint,
        decisionsFingerprint,
        reviewItemCount: normalizedDecisions.length,
        includeOriginalCount,
        redactCount,
      },
      occurredAt: approvedAt,
    });
  });

  return stored(row);
}

/** Revalidates an immutable review approval against the current source/policy. */
export async function validateAthleteDataSubjectDeliveryApproval(
  db: Database,
  tenantId: string,
  athleteId: string,
  approvalId: string,
  validatedAt = new Date().toISOString(),
): Promise<Readonly<AthleteDataSubjectDeliveryApprovalValidation>> {
  if (!Number.isFinite(Date.parse(validatedAt))) throw new Error('Validation time must be a valid ISO-8601 timestamp');
  const [approval] = await db.select().from(athleteDataSubjectDeliveryApprovals).where(and(
    eq(athleteDataSubjectDeliveryApprovals.id, approvalId),
    eq(athleteDataSubjectDeliveryApprovals.tenantId, tenantId),
    eq(athleteDataSubjectDeliveryApprovals.athleteId, athleteId),
  )).limit(1);
  if (!approval) {
    return Object.freeze({
      validForDeliveryPackaging: false,
      validatedAt,
      approvalId,
      blockers: Object.freeze(['APPROVAL_NOT_FOUND' as const]),
    });
  }

  const blockers: DataSubjectDeliveryApprovalValidationBlocker[] = [];
  if (approval.approvalVersion !== DATA_SUBJECT_DELIVERY_APPROVAL_VERSION
    || approval.sourceSchemaVersion !== DATA_SUBJECT_EXPORT_SCHEMA_VERSION
    || approval.deliveryPolicyVersion !== DATA_SUBJECT_DELIVERY_POLICY_VERSION) {
    blockers.push('CONTRACT_VERSION_CHANGED');
  }

  const source = await getAthleteDataSubjectExportSource(db, tenantId, athleteId);
  if (!source) {
    blockers.push('SOURCE_NOT_FOUND');
  } else {
    const projection = projectAthleteDataSubjectExportForDelivery(source);
    const freshSourceFingerprint = await createSourceFingerprint(source, projection);
    if (freshSourceFingerprint !== approval.sourceFingerprint) blockers.push('SOURCE_FINGERPRINT_CHANGED');

    let storedDecisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[] = [];
    try {
      storedDecisions = parseStoredDecisions(approval.reviewDecisionsJson);
      normalizeAndValidateDecisions(projection, storedDecisions);
    } catch {
      blockers.push('REVIEW_ITEMS_CHANGED');
    }
    const freshDecisionsFingerprint = await createDecisionsFingerprint(storedDecisions);
    if (freshDecisionsFingerprint !== approval.decisionsFingerprint) blockers.push('DECISIONS_FINGERPRINT_CHANGED');
  }

  return Object.freeze({
    validForDeliveryPackaging: blockers.length === 0,
    validatedAt,
    approvalId,
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
}
