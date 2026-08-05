export type AthleteRetentionBasis =
  | 'LAST_TEST'
  | 'MANAGED_PROFILE_NO_TEST'
  | 'MANUAL_REVIEW';

export type AthleteRetentionReason =
  | 'RETENTION_ACTIVE'
  | 'RETENTION_EXPIRED'
  | 'MANUAL_REVIEW_REQUIRED';

export interface AthleteRetentionPolicy {
  tenantRetentionYears: number;
}

export interface AthleteRetentionEvidence {
  athleteCreatedAt: string;
  linkedUserId: string | null;
  testReferenceTimes: string[];
  assessedAt: string;
}

export interface AthleteRetentionAssessment {
  basis: AthleteRetentionBasis;
  reason: AthleteRetentionReason;
  tenantRetentionYears: number;
  referenceAt: string | null;
  retainUntil: string | null;
  eligibleForIrreversibleAction: boolean;
}

function parseTimestamp(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be a valid ISO-8601 timestamp`);
  }
  return date;
}

function addCalendarMonths(timestamp: string, months: number): string {
  const source = parseTimestamp(timestamp, 'Retention reference time');
  const sourceMonth = source.getUTCMonth();
  const absoluteMonth = sourceMonth + months;
  const targetYear = source.getUTCFullYear() + Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(source.getUTCDate(), lastDay);

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )).toISOString();
}

function latestTimestamp(values: string[]): string | null {
  if (values.length === 0) return null;
  const parsed = values.map((value, index) => ({
    value,
    time: parseTimestamp(value, `Test reference time ${index + 1}`).getTime(),
  }));
  parsed.sort((left, right) => right.time - left.time);
  return parsed[0]!.value;
}

/**
 * Determines whether an athlete record has reached the point at which an
 * irreversible deletion/pseudonymization step may be considered.
 *
 * Immediate use blocking and soft deletion are deliberately outside this
 * contract. The assessment only governs irreversible processing.
 *
 * Rules from SPEC §32:
 * - athletes with tests: tenant-configured 1–10 years after the latest test;
 * - managed profiles without tests: 12 months after profile creation;
 * - linked profiles without tests: fail closed for manual review because the
 *   specification does not define an automatic retention period for them.
 */
export function assessAthleteRetention(
  evidence: AthleteRetentionEvidence,
  policy: AthleteRetentionPolicy,
): Readonly<AthleteRetentionAssessment> {
  if (!Number.isInteger(policy.tenantRetentionYears)
    || policy.tenantRetentionYears < 1
    || policy.tenantRetentionYears > 10) {
    throw new Error('Tenant retention years must be an integer between 1 and 10');
  }

  const athleteCreatedAt = parseTimestamp(evidence.athleteCreatedAt, 'Athlete creation time');
  const assessedAt = parseTimestamp(evidence.assessedAt, 'Assessment time');
  const latestTestAt = latestTimestamp(evidence.testReferenceTimes);

  if (latestTestAt) {
    const retainUntil = addCalendarMonths(
      latestTestAt,
      policy.tenantRetentionYears * 12,
    );
    const eligible = assessedAt.getTime() >= new Date(retainUntil).getTime();
    return Object.freeze({
      basis: 'LAST_TEST',
      reason: eligible ? 'RETENTION_EXPIRED' : 'RETENTION_ACTIVE',
      tenantRetentionYears: policy.tenantRetentionYears,
      referenceAt: latestTestAt,
      retainUntil,
      eligibleForIrreversibleAction: eligible,
    });
  }

  if (evidence.linkedUserId === null) {
    const retainUntil = addCalendarMonths(athleteCreatedAt.toISOString(), 12);
    const eligible = assessedAt.getTime() >= new Date(retainUntil).getTime();
    return Object.freeze({
      basis: 'MANAGED_PROFILE_NO_TEST',
      reason: eligible ? 'RETENTION_EXPIRED' : 'RETENTION_ACTIVE',
      tenantRetentionYears: policy.tenantRetentionYears,
      referenceAt: athleteCreatedAt.toISOString(),
      retainUntil,
      eligibleForIrreversibleAction: eligible,
    });
  }

  return Object.freeze({
    basis: 'MANUAL_REVIEW',
    reason: 'MANUAL_REVIEW_REQUIRED',
    tenantRetentionYears: policy.tenantRetentionYears,
    referenceAt: athleteCreatedAt.toISOString(),
    retainUntil: null,
    eligibleForIrreversibleAction: false,
  });
}
