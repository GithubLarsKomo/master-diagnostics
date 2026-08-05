import { assessAthleteRetention, type AthleteRetentionAssessment } from '@masters/domain';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Database } from '../client';
import { athletes, tenants, tests } from '../schema';

function testReferenceTime(test: {
  endedAt: string | null;
  startedAt: string | null;
  createdAt: string;
}): string {
  return test.endedAt ?? test.startedAt ?? test.createdAt;
}

async function requireTenantRetentionYears(
  db: Database,
  tenantId: string,
): Promise<number> {
  const [tenant] = await db
    .select({ retentionYears: tenants.retentionYears })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error('Tenant not found');
  return tenant.retentionYears;
}

function assessAthleteRecord(
  athlete: {
    linkedUserId: string | null;
    createdAt: string;
  },
  athleteTests: Array<{
    endedAt: string | null;
    startedAt: string | null;
    createdAt: string;
  }>,
  retentionYears: number,
  assessedAt: string,
): Readonly<AthleteRetentionAssessment> {
  return assessAthleteRetention({
    athleteCreatedAt: athlete.createdAt,
    linkedUserId: athlete.linkedUserId,
    testReferenceTimes: athleteTests.map(testReferenceTime),
    assessedAt,
  }, {
    tenantRetentionYears: retentionYears,
  });
}

/**
 * Read-only assessment of the retention boundary for irreversible athlete-data
 * processing. Soft deletion/use blocking remains independent and may happen
 * immediately after an approved request.
 */
export async function getAthleteRetentionAssessment(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<AthleteRetentionAssessment>> {
  const retentionYears = await requireTenantRetentionYears(db, tenantId);

  const [athlete] = await db
    .select({
      id: athletes.id,
      linkedUserId: athletes.linkedUserId,
      createdAt: athletes.createdAt,
    })
    .from(athletes)
    .where(and(
      eq(athletes.id, athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .limit(1);
  if (!athlete) throw new Error('Athlete not found');

  const athleteTests = await db
    .select({
      status: tests.status,
      endedAt: tests.endedAt,
      startedAt: tests.startedAt,
      createdAt: tests.createdAt,
    })
    .from(tests)
    .where(and(
      eq(tests.tenantId, tenantId),
      eq(tests.athleteId, athleteId),
      ne(tests.status, 'PLANNED'),
    ));

  return assessAthleteRecord(athlete, athleteTests, retentionYears, assessedAt);
}

export type TenantRetentionCandidateDisposition = 'ELIGIBLE' | 'MANUAL_REVIEW';

export interface TenantRetentionCandidate {
  athleteId: string;
  linkedUserId: string | null;
  consentBlockedAt: string | null;
  deletedAt: string | null;
  disposition: TenantRetentionCandidateDisposition;
  assessment: Readonly<AthleteRetentionAssessment>;
}

async function listTenantRetentionCandidatesWithYears(
  db: Database,
  tenantId: string,
  retentionYears: number,
  assessedAt: string,
): Promise<ReadonlyArray<Readonly<TenantRetentionCandidate>>> {
  const tenantAthletes = await db
    .select({
      id: athletes.id,
      linkedUserId: athletes.linkedUserId,
      consentBlockedAt: athletes.consentBlockedAt,
      deletedAt: athletes.deletedAt,
      createdAt: athletes.createdAt,
    })
    .from(athletes)
    .where(eq(athletes.tenantId, tenantId))
    .orderBy(asc(athletes.id));

  const tenantTests = await db
    .select({
      athleteId: tests.athleteId,
      endedAt: tests.endedAt,
      startedAt: tests.startedAt,
      createdAt: tests.createdAt,
    })
    .from(tests)
    .where(and(
      eq(tests.tenantId, tenantId),
      ne(tests.status, 'PLANNED'),
    ));

  const testsByAthlete = new Map<string, typeof tenantTests>();
  for (const test of tenantTests) {
    const athleteTests = testsByAthlete.get(test.athleteId) ?? [];
    athleteTests.push(test);
    testsByAthlete.set(test.athleteId, athleteTests);
  }

  return tenantAthletes.flatMap((athlete) => {
    const assessment = assessAthleteRecord(
      athlete,
      testsByAthlete.get(athlete.id) ?? [],
      retentionYears,
      assessedAt,
    );
    if (assessment.reason === 'RETENTION_ACTIVE') return [];

    return [Object.freeze({
      athleteId: athlete.id,
      linkedUserId: athlete.linkedUserId,
      consentBlockedAt: athlete.consentBlockedAt,
      deletedAt: athlete.deletedAt,
      disposition: assessment.eligibleForIrreversibleAction
        ? 'ELIGIBLE' as const
        : 'MANUAL_REVIEW' as const,
      assessment,
    })];
  });
}

/**
 * Builds a deterministic tenant-wide read-only worklist for a later retention
 * job. Active retention periods are omitted. Expired assessments are marked
 * ELIGIBLE, while ambiguous linked profiles remain MANUAL_REVIEW and therefore
 * cannot be processed irreversibly by an automated writer.
 */
export async function listTenantRetentionCandidates(
  db: Database,
  tenantId: string,
  assessedAt = new Date().toISOString(),
): Promise<ReadonlyArray<Readonly<TenantRetentionCandidate>>> {
  const retentionYears = await requireTenantRetentionYears(db, tenantId);
  return listTenantRetentionCandidatesWithYears(
    db,
    tenantId,
    retentionYears,
    assessedAt,
  );
}

export interface RetentionJobTenantPlan {
  tenantId: string;
  candidateCount: number;
  eligibleCount: number;
  manualReviewCount: number;
  candidates: ReadonlyArray<Readonly<TenantRetentionCandidate>>;
}

export interface RetentionJobPlan {
  mode: 'READ_ONLY';
  assessedAt: string;
  tenantCount: number;
  candidateCount: number;
  eligibleCount: number;
  manualReviewCount: number;
  tenants: ReadonlyArray<Readonly<RetentionJobTenantPlan>>;
}

export interface RetentionJobPlanOptions {
  tenantId?: string;
  assessedAt?: string;
}

/**
 * Produces the schedulable retention-job plan without mutating any tenant or
 * athlete data. Tenants are processed sequentially and remain isolated from one
 * another. An optional tenant filter supports single-tenant club operation and
 * targeted administrative runs.
 */
export async function buildRetentionJobPlan(
  db: Database,
  options: RetentionJobPlanOptions = {},
): Promise<Readonly<RetentionJobPlan>> {
  const assessedAt = options.assessedAt ?? new Date().toISOString();
  const tenantRows = options.tenantId
    ? await db
      .select({ id: tenants.id, retentionYears: tenants.retentionYears })
      .from(tenants)
      .where(eq(tenants.id, options.tenantId))
      .orderBy(asc(tenants.id))
    : await db
      .select({ id: tenants.id, retentionYears: tenants.retentionYears })
      .from(tenants)
      .orderBy(asc(tenants.id));

  if (options.tenantId && tenantRows.length === 0) {
    throw new Error('Tenant not found');
  }

  const tenantPlans: Array<Readonly<RetentionJobTenantPlan>> = [];
  for (const tenant of tenantRows) {
    const candidates = await listTenantRetentionCandidatesWithYears(
      db,
      tenant.id,
      tenant.retentionYears,
      assessedAt,
    );
    const eligibleCount = candidates.filter(
      (candidate) => candidate.disposition === 'ELIGIBLE',
    ).length;
    const manualReviewCount = candidates.length - eligibleCount;

    tenantPlans.push(Object.freeze({
      tenantId: tenant.id,
      candidateCount: candidates.length,
      eligibleCount,
      manualReviewCount,
      candidates: Object.freeze([...candidates]),
    }));
  }

  const candidateCount = tenantPlans.reduce(
    (sum, tenant) => sum + tenant.candidateCount,
    0,
  );
  const eligibleCount = tenantPlans.reduce(
    (sum, tenant) => sum + tenant.eligibleCount,
    0,
  );
  const manualReviewCount = tenantPlans.reduce(
    (sum, tenant) => sum + tenant.manualReviewCount,
    0,
  );

  return Object.freeze({
    mode: 'READ_ONLY' as const,
    assessedAt,
    tenantCount: tenantPlans.length,
    candidateCount,
    eligibleCount,
    manualReviewCount,
    tenants: Object.freeze(tenantPlans),
  });
}
