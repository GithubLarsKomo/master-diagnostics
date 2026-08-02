import { and, desc, eq, max } from 'drizzle-orm';
import type { Database } from '../client';
import { interpretations, reportVersions, tests } from '../schema';

export type ReportLocale = 'de' | 'en';

export interface AppendReportVersionInput {
  interpretationId: string;
  locale: ReportLocale;
  contentHash: string;
  storageReference: string;
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

function validateInput(input: AppendReportVersionInput): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.contentHash)) {
    throw new Error('Report content hash is invalid');
  }
  if (!input.storageReference.trim()) {
    throw new Error('Report storage reference is required');
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
