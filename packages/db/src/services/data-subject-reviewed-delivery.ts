import {
  DATA_SUBJECT_DELIVERY_POLICY_VERSION,
  DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
  DATA_SUBJECT_EXPORT_SECTIONS,
  DATA_SUBJECT_REVIEWED_DELIVERY_VERSION,
  DATA_SUBJECT_REVIEW_REDACTION,
  projectAthleteDataSubjectExportForDelivery,
  type AthleteDataSubjectDeliveryProjection,
  type AthleteDataSubjectExportSource,
  type AthleteDataSubjectReviewedDeliverySnapshot,
  type DataSubjectDeliveryReviewDecisionInput,
  type DataSubjectDeliveryReviewItem,
  type DataSubjectExportRow,
  type DataSubjectExportSection,
} from '@masters/domain';
import type { Database } from '../client';
import {
  getAthleteDataSubjectDeliveryApproval,
  validateAthleteDataSubjectDeliveryApproval,
  type DataSubjectDeliveryApprovalFingerprint,
} from './data-subject-delivery-approval';
import { getAthleteDataSubjectExportSource } from './data-subject-export';

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

function rowId(row: DataSubjectExportRow): string {
  return typeof row.id === 'string' ? row.id : '[NO_ROW_ID]';
}

function normalizedReviewItems(projection: Readonly<AthleteDataSubjectDeliveryProjection>) {
  return [...projection.reviewItems]
    .map((item) => ({ section: item.section, rowId: item.rowId, field: item.field, reason: item.reason }))
    .sort((left, right) => reviewKey(left).localeCompare(reviewKey(right)));
}

async function sourceFingerprint(
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

async function decisionsFingerprint(
  decisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[],
): Promise<DataSubjectDeliveryApprovalFingerprint> {
  return fingerprint({
    contract: 'athlete-data-subject-delivery-review-decisions-v1',
    decisions,
  });
}

function decisionMap(
  decisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[],
): ReadonlyMap<string, Readonly<DataSubjectDeliveryReviewDecisionInput>> {
  const map = new Map<string, Readonly<DataSubjectDeliveryReviewDecisionInput>>();
  for (const decision of decisions) {
    const key = reviewKey(decision);
    if (map.has(key)) throw new Error('Duplicate stored data subject delivery review decision');
    map.set(key, decision);
  }
  return map;
}

function applyReviewDecisions(
  source: Readonly<AthleteDataSubjectExportSource>,
  projection: Readonly<AthleteDataSubjectDeliveryProjection>,
  decisions: readonly Readonly<DataSubjectDeliveryReviewDecisionInput>[],
): Readonly<AthleteDataSubjectExportSource> {
  const decisionsByKey = decisionMap(decisions);
  const expectedKeys = new Set(projection.reviewItems.map(reviewKey));
  if (decisionsByKey.size !== expectedKeys.size
    || [...expectedKeys].some((key) => !decisionsByKey.has(key))) {
    throw new Error('Stored review decisions do not exactly cover the current review items');
  }

  const applied = new Set<string>();
  const data = Object.fromEntries(DATA_SUBJECT_EXPORT_SECTIONS.map((section) => {
    const rawRows = source.data[section];
    const projectedRows = projection.projectedSource.data[section];
    if (rawRows.length !== projectedRows.length) {
      throw new Error(`Reviewed delivery row alignment failed for ${section}`);
    }

    const rows = rawRows.map((rawRow, index) => {
      const projectedRow = projectedRows[index];
      if (!projectedRow) throw new Error(`Reviewed delivery projected row missing for ${section}`);
      const id = rowId(rawRow);
      const reviewed: Record<string, unknown> = { ...projectedRow };
      for (const item of projection.reviewItems) {
        if (item.section !== section || item.rowId !== id) continue;
        const key = reviewKey(item);
        const decision = decisionsByKey.get(key);
        if (!decision) throw new Error('Stored review decision missing for current review item');
        const rawValue = rawRow[item.field];
        if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
          throw new Error('Reviewed free-text source no longer matches the approved review item');
        }
        reviewed[item.field] = decision.decision === 'INCLUDE_ORIGINAL'
          ? rawValue
          : DATA_SUBJECT_REVIEW_REDACTION;
        applied.add(key);
      }
      return Object.freeze(reviewed);
    });
    return [section, Object.freeze(rows)] as const;
  })) as unknown as Readonly<Record<DataSubjectExportSection, readonly DataSubjectExportRow[]>>;

  if (applied.size !== expectedKeys.size) {
    throw new Error('Not all approved review decisions were applied');
  }

  return Object.freeze({
    tenantId: source.tenantId,
    athleteId: source.athleteId,
    data: Object.freeze(data),
    reportArtifacts: Object.freeze(source.reportArtifacts.map((artifact) => Object.freeze({ ...artifact }))),
  });
}

/**
 * Builds the deterministic in-memory source for later package creation. The
 * stored approval is revalidated first, then the exact source instance used for
 * output is re-fingerprinted before any INCLUDE_ORIGINAL decision can reveal
 * reviewed free text. This service is read-only and does not constitute an
 * export or download event.
 */
export async function buildAthleteDataSubjectReviewedDeliverySnapshot(
  db: Database,
  tenantId: string,
  athleteId: string,
  approvalId: string,
  validatedAt = new Date().toISOString(),
): Promise<Readonly<AthleteDataSubjectReviewedDeliverySnapshot>> {
  const validation = await validateAthleteDataSubjectDeliveryApproval(
    db,
    tenantId,
    athleteId,
    approvalId,
    validatedAt,
  );
  if (!validation.validForDeliveryPackaging) {
    throw new Error(`Data subject delivery approval is not valid for reviewed projection: ${validation.blockers.join(', ')}`);
  }

  const [approval, source] = await Promise.all([
    getAthleteDataSubjectDeliveryApproval(db, tenantId, athleteId, approvalId),
    getAthleteDataSubjectExportSource(db, tenantId, athleteId),
  ]);
  if (!approval || !source) throw new Error('Validated data subject delivery approval/source disappeared');

  const projection = projectAthleteDataSubjectExportForDelivery(source);
  const [freshSourceFingerprint, freshDecisionsFingerprint] = await Promise.all([
    sourceFingerprint(source, projection),
    decisionsFingerprint(approval.reviewDecisions),
  ]);
  if (freshSourceFingerprint !== approval.sourceFingerprint) {
    throw new Error('Data subject source changed after approval validation');
  }
  if (freshDecisionsFingerprint !== approval.decisionsFingerprint) {
    throw new Error('Data subject review decisions changed after approval validation');
  }

  const reviewedSource = applyReviewDecisions(source, projection, approval.reviewDecisions);
  const reviewedFingerprint = await fingerprint({
    contract: DATA_SUBJECT_REVIEWED_DELIVERY_VERSION,
    approvalId,
    sourceFingerprint: approval.sourceFingerprint,
    decisionsFingerprint: approval.decisionsFingerprint,
    reviewedSource,
  });

  return Object.freeze({
    version: DATA_SUBJECT_REVIEWED_DELIVERY_VERSION,
    approvalId,
    sourceFingerprint: approval.sourceFingerprint,
    decisionsFingerprint: approval.decisionsFingerprint,
    reviewedFingerprint,
    reviewedSource,
  });
}
