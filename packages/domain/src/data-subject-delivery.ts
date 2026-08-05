import {
  DATA_SUBJECT_EXPORT_SECTIONS,
  type AthleteDataSubjectExportSource,
  type DataSubjectExportRow,
  type DataSubjectExportSection,
} from './data-subject-export';

export const DATA_SUBJECT_DELIVERY_POLICY_VERSION = 'masters-data-subject-delivery-v1' as const;
export const DATA_SUBJECT_THIRD_PARTY_REDACTION = '[THIRD_PARTY_REDACTED]' as const;
export const DATA_SUBJECT_REVIEW_REQUIRED = '[REVIEW_REQUIRED]' as const;

export type DataSubjectDeliveryReviewReason = 'FREE_TEXT_REVIEW_REQUIRED';
export type DataSubjectDeliveryRedactionReason = 'THIRD_PARTY_IDENTIFIER';
export type DataSubjectDeliveryReviewDecision = 'INCLUDE_ORIGINAL' | 'REDACT';

export interface DataSubjectDeliveryReviewItem {
  section: DataSubjectExportSection;
  rowId: string;
  field: string;
  reason: DataSubjectDeliveryReviewReason;
}

export interface DataSubjectDeliveryReviewDecisionInput {
  section: DataSubjectExportSection;
  rowId: string;
  field: string;
  decision: DataSubjectDeliveryReviewDecision;
}

export interface DataSubjectDeliveryRedaction {
  section: DataSubjectExportSection;
  rowId: string;
  field: string;
  reason: DataSubjectDeliveryRedactionReason;
}

export interface AthleteDataSubjectDeliveryProjection {
  policyVersion: typeof DATA_SUBJECT_DELIVERY_POLICY_VERSION;
  readyForDelivery: boolean;
  projectedSource: Readonly<AthleteDataSubjectExportSource>;
  automaticRedactions: readonly Readonly<DataSubjectDeliveryRedaction>[];
  reviewItems: readonly Readonly<DataSubjectDeliveryReviewItem>[];
}

const FREE_TEXT_FIELDS = new Set([
  'notes',
  'reason',
  'decision_reason',
  'rationale',
  'comment',
  'comments',
  'free_text',
]);

function rowId(row: DataSubjectExportRow): string {
  return typeof row.id === 'string' ? row.id : '[NO_ROW_ID]';
}

function isThirdPartyIdentifier(section: DataSubjectExportSection, field: string): boolean {
  if (section === 'athlete_guardians' && ['full_name', 'email', 'phone'].includes(field)) return true;
  if (field === 'linked_user_id') return false;
  return field === 'coach_user_id' || field.endsWith('_by_user_id') || field.endsWith('_trainer_user_id');
}

function isReviewableFreeText(field: string, value: unknown): boolean {
  return FREE_TEXT_FIELDS.has(field) && typeof value === 'string' && value.trim().length > 0;
}

/**
 * Converts the internal subject-data source into a fail-closed delivery view.
 * Known third-party identifiers are removed automatically. Potentially free
 * text is withheld entirely until a later administrative review explicitly
 * replaces or approves it; raw text never appears in the projected source.
 */
export function projectAthleteDataSubjectExportForDelivery(
  source: Readonly<AthleteDataSubjectExportSource>,
): Readonly<AthleteDataSubjectDeliveryProjection> {
  const automaticRedactions: DataSubjectDeliveryRedaction[] = [];
  const reviewItems: DataSubjectDeliveryReviewItem[] = [];

  const data = Object.fromEntries(DATA_SUBJECT_EXPORT_SECTIONS.map((section) => {
    const rows = source.data[section].map((row) => {
      const id = rowId(row);
      const projected: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(row)) {
        if (value !== null && value !== undefined && isThirdPartyIdentifier(section, field)) {
          projected[field] = DATA_SUBJECT_THIRD_PARTY_REDACTION;
          automaticRedactions.push({ section, rowId: id, field, reason: 'THIRD_PARTY_IDENTIFIER' });
          continue;
        }
        if (isReviewableFreeText(field, value)) {
          projected[field] = DATA_SUBJECT_REVIEW_REQUIRED;
          reviewItems.push({ section, rowId: id, field, reason: 'FREE_TEXT_REVIEW_REQUIRED' });
          continue;
        }
        projected[field] = value;
      }
      return Object.freeze(projected);
    });
    return [section, Object.freeze(rows)] as const;
  })) as unknown as Readonly<Record<DataSubjectExportSection, readonly DataSubjectExportRow[]>>;

  const projectedSource: AthleteDataSubjectExportSource = Object.freeze({
    tenantId: source.tenantId,
    athleteId: source.athleteId,
    data: Object.freeze(data),
    reportArtifacts: Object.freeze(source.reportArtifacts.map((artifact) => Object.freeze({ ...artifact }))),
  });

  return Object.freeze({
    policyVersion: DATA_SUBJECT_DELIVERY_POLICY_VERSION,
    readyForDelivery: reviewItems.length === 0,
    projectedSource,
    automaticRedactions: Object.freeze(automaticRedactions.map((item) => Object.freeze({ ...item }))),
    reviewItems: Object.freeze(reviewItems.map((item) => Object.freeze({ ...item }))),
  });
}
