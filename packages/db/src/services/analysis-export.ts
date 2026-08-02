import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { protocolTemplateVersions, testPlanSnapshots, tests } from '../schema';

export interface AnalysisExportCohortEvidence {
  testYear: number;
  deviceType: string;
  protocolVersion: string;
  equivalenceClassSize: number;
}

/**
 * Counts released tests in the same tenant that expose the same structural
 * quasi-identifiers as the anonymized analysis export: test year, device type,
 * and protocol version. Physiological values are deliberately excluded from
 * the equivalence key because they are the analysis payload itself.
 */
export async function getAnalysisExportCohortEvidence(
  db: Database,
  tenantId: string,
  testId: string,
): Promise<Readonly<AnalysisExportCohortEvidence> | null> {
  const [target] = await db
    .select({
      releasedAt: tests.releasedAt,
      deviceType: tests.deviceType,
      protocolVersion: protocolTemplateVersions.versionNumber,
    })
    .from(tests)
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .innerJoin(protocolTemplateVersions, and(
      eq(protocolTemplateVersions.id, testPlanSnapshots.protocolVersionId),
      eq(protocolTemplateVersions.tenantId, tenantId),
    ))
    .where(and(
      eq(tests.id, testId),
      eq(tests.tenantId, tenantId),
      eq(tests.status, 'RELEASED'),
    ))
    .limit(1);

  if (!target?.releasedAt) return null;
  const testYear = Number(target.releasedAt.slice(0, 4));
  if (!Number.isInteger(testYear)) return null;

  const [cohort] = await db
    .select({ size: sql<number>`count(*)` })
    .from(tests)
    .innerJoin(testPlanSnapshots, and(
      eq(testPlanSnapshots.testId, tests.id),
      eq(testPlanSnapshots.tenantId, tenantId),
    ))
    .innerJoin(protocolTemplateVersions, and(
      eq(protocolTemplateVersions.id, testPlanSnapshots.protocolVersionId),
      eq(protocolTemplateVersions.tenantId, tenantId),
    ))
    .where(and(
      eq(tests.tenantId, tenantId),
      eq(tests.status, 'RELEASED'),
      eq(tests.deviceType, target.deviceType),
      eq(protocolTemplateVersions.versionNumber, target.protocolVersion),
      sql`substr(${tests.releasedAt}, 1, 4) = ${String(testYear)}`,
    ));

  return Object.freeze({
    testYear,
    deviceType: target.deviceType,
    protocolVersion: String(target.protocolVersion),
    equivalenceClassSize: Number(cohort?.size ?? 0),
  });
}
