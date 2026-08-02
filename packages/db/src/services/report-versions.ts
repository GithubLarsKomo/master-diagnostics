import { and, desc, eq, max } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athletes,
  interpretations,
  protocolTemplateVersions,
  reportVersions,
  tenants,
  testPlanSnapshots,
  tests,
  users,
} from '../schema';

export type ReportLocale = 'de' | 'en';

export interface AppendReportVersionInput {
  interpretationId: string;
  locale: ReportLocale;
  contentHash: string;
  storageReference: string;
  expectedVersionNumber?: number;
}

export interface StoredReportVersion {
  id: string;
  tenantId: string;
  testId: string;
  interpretationId: string;
  versionNumber: number;
  locale: ReportLocale;
  contentHash: string;
  storageReference: string;
  createdAt: string;
}

export interface ReportGenerationSource {
  interpretationId: string;
  athleteName: string;
  testDate: string;
  trainerName: string;
  tenantName: string;
  deviceType: 'BIKEERG' | 'ROWERG' | 'RP3';
  protocolVersion: string;
  releasedAt: string;
  lt1Json: string;
  lt2Json: string;
  trainerComment: string | null;
}

function validateInput(input: AppendReportVersionInput): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.contentHash)) {
    throw new Error('Report content hash is invalid');
  }
  if (!input.storageReference.trim()) {
    throw new Error('Report storage reference is required');
  }
  if (input.expectedVersionNumber !== undefined
    && (!Number.isInteger(input.expectedVersionNumber) || input.expectedVersionNumber < 1)) {
    throw new Error('Expected report version number must be a positive integer');
  }
}

function stored(row: typeof reportVersions.$inferSelect): StoredReportVersion {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    testId: row.testId,
    interpretationId: row.interpretationId,
    versionNumber: row.versionNumber,
    locale: row.locale,
    contentHash: row.contentHash,
    storageReference: row.storageReference,
    createdAt: row.createdAt,
  });
}

async function requireReleasedInterpretation(
  db: Database,
  tenantId: string,
  testId: string,
  interpretationId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: interpretations.id })
    .from(interpretations)
    .innerJoin(tests, and(eq(tests.id, interpretations.testId), eq(tests.tenantId, tenantId)))
    .where(and(
      eq(interpretations.id, interpretationId),
      eq(interpretations.tenantId, tenantId),
      eq(interpretations.testId, testId),
      eq(interpretations.status, 'RELEASED'),
    ))
    .limit(1);
  if (!row) throw new Error('Released interpretation not found for tenant test');
}

export async function getNextReportVersionNumber(
  db: Database,
  tenantId: string,
  testId: string,
  locale: ReportLocale,
): Promise<number> {
  const [latest] = await db
    .select({ versionNumber: max(reportVersions.versionNumber) })
    .from(reportVersions)
    .where(and(
      eq(reportVersions.tenantId, tenantId),
      eq(reportVersions.testId, testId),
      eq(reportVersions.locale, locale),
    ));
  return (latest?.versionNumber ?? 0) + 1;
}

/** Loads the latest released interpretation and immutable report metadata for one tenant test. */
export async function getReportGenerationSource(
  db: Database,
  tenantId: string,
  testId: string,
): Promise<ReportGenerationSource | null> {
  const [row] = await db
    .select({
      interpretationId: interpretations.id,
      athleteFirstName: athletes.firstName,
      athleteLastName: athletes.lastName,
      testEndedAt: tests.endedAt,
      testReleasedAt: tests.releasedAt,
      testCreatedAt: tests.createdAt,
      trainerName: users.displayName,
      tenantName: tenants.name,
      deviceType: tests.deviceType,
      protocolVersionNumber: protocolTemplateVersions.versionNumber,
      releasedAt: interpretations.releasedAt,
      lt1Json: interpretations.lt1Json,
      lt2Json: interpretations.lt2Json,
      trainerComment: interpretations.rationale,
    })
    .from(interpretations)
    .innerJoin(tests, and(
      eq(tests.id, interpretations.testId),
      eq(tests.tenantId, tenantId),
    ))
    .innerJoin(athletes, and(
      eq(athletes.id, tests.athleteId),
      eq(athletes.tenantId, tenantId),
    ))
    .innerJoin(tenants, eq(tenants.id, tenantId))
    .innerJoin(users, eq(users.id, tests.conductingTrainerUserId))
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .innerJoin(protocolTemplateVersions, and(
      eq(protocolTemplateVersions.id, testPlanSnapshots.protocolVersionId),
      eq(protocolTemplateVersions.tenantId, tenantId),
    ))
    .where(and(
      eq(interpretations.tenantId, tenantId),
      eq(interpretations.testId, testId),
      eq(interpretations.status, 'RELEASED'),
    ))
    .orderBy(desc(interpretations.versionNumber))
    .limit(1);

  if (!row || !row.releasedAt) return null;
  return Object.freeze({
    interpretationId: row.interpretationId,
    athleteName: `${row.athleteFirstName} ${row.athleteLastName}`.trim(),
    testDate: row.testEndedAt ?? row.testReleasedAt ?? row.testCreatedAt,
    trainerName: row.trainerName,
    tenantName: row.tenantName,
    deviceType: row.deviceType,
    protocolVersion: String(row.protocolVersionNumber),
    releasedAt: row.releasedAt,
    lt1Json: row.lt1Json,
    lt2Json: row.lt2Json,
    trainerComment: row.trainerComment,
  });
}

/** Appends an immutable report version for one released interpretation and locale. */
export async function appendReportVersion(
  db: Database,
  tenantId: string,
  testId: string,
  input: AppendReportVersionInput,
): Promise<StoredReportVersion> {
  validateInput(input);
  await requireReleasedInterpretation(db, tenantId, testId, input.interpretationId);

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ versionNumber: max(reportVersions.versionNumber) })
      .from(reportVersions)
      .where(and(
        eq(reportVersions.tenantId, tenantId),
        eq(reportVersions.testId, testId),
        eq(reportVersions.locale, input.locale),
      ));
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    if (input.expectedVersionNumber !== undefined && input.expectedVersionNumber !== versionNumber) {
      throw new Error('Report version changed during generation');
    }
    const now = new Date().toISOString();
    const [created] = await tx.insert(reportVersions).values({
      id: crypto.randomUUID(),
      tenantId,
      testId,
      interpretationId: input.interpretationId,
      versionNumber,
      locale: input.locale,
      contentHash: input.contentHash,
      storageReference: input.storageReference,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!created) throw new Error('Report version was not persisted');
    return stored(created);
  });
}

/** Reads one immutable report version inside the tenant/test boundary. */
export async function getReportVersion(
  db: Database,
  tenantId: string,
  testId: string,
  reportVersionId: string,
): Promise<StoredReportVersion | null> {
  const [row] = await db
    .select()
    .from(reportVersions)
    .where(and(
      eq(reportVersions.id, reportVersionId),
      eq(reportVersions.tenantId, tenantId),
      eq(reportVersions.testId, testId),
    ))
    .limit(1);
  return row ? stored(row) : null;
}

export async function listReportVersions(
  db: Database,
  tenantId: string,
  testId: string,
  locale?: ReportLocale,
): Promise<readonly StoredReportVersion[]> {
  const conditions = [eq(reportVersions.tenantId, tenantId), eq(reportVersions.testId, testId)];
  if (locale) conditions.push(eq(reportVersions.locale, locale));
  const rows = await db
    .select()
    .from(reportVersions)
    .where(and(...conditions))
    .orderBy(desc(reportVersions.versionNumber));
  return Object.freeze(rows.map(stored));
}
