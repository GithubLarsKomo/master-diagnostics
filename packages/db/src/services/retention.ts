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
