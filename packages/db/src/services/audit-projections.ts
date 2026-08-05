const REDACTED = '[REDACTED]';

const athleteMutableFields = [
  'firstName',
  'lastName',
  'birthDate',
  'referenceCategory',
  'heightCm',
  'currentWeightKgX100',
  'primarySport',
  'primaryDiscipline',
  'trainingStatus',
] as const;

export type AthleteMutableField = typeof athleteMutableFields[number];

export interface AthleteAuditSource {
  firstName: string;
  lastName: string;
  birthDate: string;
  referenceCategory: string;
  heightCm: number;
  currentWeightKgX100: number;
  primarySport: string;
  primaryDiscipline: string;
  trainingStatus: string;
}

/**
 * Keeps the audit state useful for non-direct diagnostic fields while ensuring
 * that direct identity values are never copied into new athlete audit payloads.
 * Name/date changes remain observable through `changedFields`.
 */
export function projectAthleteForAudit(source: AthleteAuditSource) {
  return Object.freeze({
    auditSchemaVersion: 2,
    directIdentifiersRedacted: true,
    firstName: REDACTED,
    lastName: REDACTED,
    birthDate: REDACTED,
    referenceCategory: source.referenceCategory,
    heightCm: source.heightCm,
    currentWeightKgX100: source.currentWeightKgX100,
    primarySport: source.primarySport,
    primaryDiscipline: source.primaryDiscipline,
    trainingStatus: source.trainingStatus,
  });
}

export function changedAthleteFields(
  before: AthleteAuditSource,
  after: AthleteAuditSource,
): ReadonlyArray<AthleteMutableField> {
  return Object.freeze(athleteMutableFields.filter(
    (field) => before[field] !== after[field],
  ));
}

export function allAthleteMutableFields(): ReadonlyArray<AthleteMutableField> {
  return athleteMutableFields;
}

export interface GuardianAuditSource {
  athleteId: string;
  fullName: string;
  relationship: string;
  email: string | null;
  phone: string | null;
  authorityConfirmedAt: string;
  validUntil: string | null;
  revokedAt: string | null;
}

/**
 * Guardian contact details are direct identifiers of a third party and are not
 * required in the structured audit state. Relationship and lifecycle metadata
 * remain available for accountability; revocation reasons stay in the
 * dedicated audit `reason` field.
 */
export function projectGuardianForAudit(source: GuardianAuditSource) {
  return Object.freeze({
    auditSchemaVersion: 2,
    directIdentifiersRedacted: true,
    athleteId: source.athleteId,
    fullName: REDACTED,
    relationship: source.relationship,
    email: source.email === null ? null : REDACTED,
    phone: source.phone === null ? null : REDACTED,
    authorityConfirmedAt: source.authorityConfirmedAt,
    validUntil: source.validUntil,
    revokedAt: source.revokedAt,
  });
}

export interface DeletionRequestAuditSource {
  id: string;
  athleteId: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  completedAt: string | null;
}

/**
 * Request and decision reasons belong in the dedicated audit `reason` column.
 * They are intentionally not duplicated into before/after JSON payloads.
 */
export function projectDeletionRequestForAudit(source: DeletionRequestAuditSource) {
  return Object.freeze({
    auditSchemaVersion: 2,
    id: source.id,
    athleteId: source.athleteId,
    status: source.status,
    requestedAt: source.requestedAt,
    decidedAt: source.decidedAt,
    completedAt: source.completedAt,
  });
}

export interface AthleteDeletionStateAuditSource {
  id: string;
  linkedUserId: string | null;
  consentBlockedAt: string | null;
  deletedAt: string | null;
}

export function projectAthleteDeletionStateForAudit(
  source: AthleteDeletionStateAuditSource,
) {
  return Object.freeze({
    auditSchemaVersion: 2,
    id: source.id,
    linkedUserAttached: source.linkedUserId !== null,
    consentBlockedAt: source.consentBlockedAt,
    deletedAt: source.deletedAt,
  });
}
