import type {
  AthleteDataSubjectExportSource,
  DataSubjectExportRow,
  DataSubjectExportSection,
} from '@masters/domain';
import { DATA_SUBJECT_EXPORT_SECTIONS } from '@masters/domain';
import type { Database } from '../client';

interface SubjectSectionQuery {
  section: DataSubjectExportSection;
  sql: string;
  args: readonly string[];
}

const athleteTestSubquery = 'SELECT id FROM tests WHERE tenant_id = ? AND athlete_id = ?';

function plainRows(rows: readonly Record<string, unknown>[]): DataSubjectExportRow[] {
  return rows.map((row) => ({ ...row }));
}

async function queryRows(
  db: Database,
  query: Readonly<SubjectSectionQuery>,
): Promise<readonly [DataSubjectExportSection, DataSubjectExportRow[]]> {
  const result = await db.$client.execute({ sql: query.sql, args: [...query.args] });
  return [query.section, plainRows(result.rows)];
}

/**
 * Collects the athlete-owned fachliche data that forms the read-only source for
 * a later audited data-subject delivery package. It deliberately excludes
 * tenant-wide users/settings, auth/session data, secrets, audit internals and
 * tenant export packages. Report PDFs are inventoried as external references;
 * this service never reads or copies file-system artifacts.
 */
export async function getAthleteDataSubjectExportSource(
  db: Database,
  tenantId: string,
  athleteId: string,
): Promise<Readonly<AthleteDataSubjectExportSource> | null> {
  const athleteResult = await db.$client.execute({
    sql: 'SELECT * FROM athletes WHERE tenant_id = ? AND id = ? LIMIT 1',
    args: [tenantId, athleteId],
  });
  const athlete = athleteResult.rows[0];
  if (!athlete) return null;

  const testArgs = [tenantId, tenantId, athleteId] as const;
  const queries: SubjectSectionQuery[] = [
    {
      section: 'athlete_snapshots',
      sql: 'SELECT * FROM athlete_snapshots WHERE tenant_id = ? AND athlete_id = ? ORDER BY created_at, id',
      args: [tenantId, athleteId],
    },
    {
      section: 'coach_athlete_assignments',
      sql: 'SELECT * FROM coach_athlete_assignments WHERE tenant_id = ? AND athlete_id = ? ORDER BY created_at, id',
      args: [tenantId, athleteId],
    },
    {
      section: 'consents',
      sql: 'SELECT * FROM consents WHERE tenant_id = ? AND athlete_id = ? ORDER BY created_at, id',
      args: [tenantId, athleteId],
    },
    {
      section: 'athlete_guardians',
      sql: 'SELECT * FROM athlete_guardians WHERE tenant_id = ? AND athlete_id = ? ORDER BY created_at, id',
      args: [tenantId, athleteId],
    },
    {
      section: 'athlete_deletion_requests',
      sql: 'SELECT * FROM athlete_deletion_requests WHERE tenant_id = ? AND athlete_id = ? ORDER BY created_at, id',
      args: [tenantId, athleteId],
    },
    {
      section: 'tests',
      sql: 'SELECT * FROM tests WHERE tenant_id = ? AND athlete_id = ? ORDER BY created_at, id',
      args: [tenantId, athleteId],
    },
    {
      section: 'test_plan_snapshots',
      sql: `SELECT * FROM test_plan_snapshots WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'test_safety_checklist_confirmations',
      sql: `SELECT * FROM test_safety_checklist_confirmations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'test_termination_events',
      sql: `SELECT * FROM test_termination_events WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'test_stages',
      sql: `SELECT * FROM test_stages WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'rest_measurements',
      sql: `SELECT * FROM rest_measurements WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'recovery_measurements',
      sql: `SELECT * FROM recovery_measurements WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'quality_flags',
      sql: `SELECT * FROM quality_flags WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'measurement_corrections',
      sql: `SELECT * FROM measurement_corrections WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'threshold_runs',
      sql: `SELECT * FROM threshold_runs WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'threshold_results',
      sql: `SELECT * FROM threshold_results WHERE tenant_id = ? AND threshold_run_id IN (SELECT id FROM threshold_runs WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})) ORDER BY created_at, id`,
      args: [tenantId, tenantId, tenantId, athleteId],
    },
    {
      section: 'diagnostic_result_snapshots',
      sql: `SELECT * FROM diagnostic_result_snapshots WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'interpretations',
      sql: `SELECT * FROM interpretations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
    {
      section: 'zone_profiles',
      sql: `SELECT * FROM zone_profiles WHERE tenant_id = ? AND interpretation_id IN (SELECT id FROM interpretations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})) ORDER BY created_at, id`,
      args: [tenantId, tenantId, tenantId, athleteId],
    },
    {
      section: 'report_versions',
      sql: `SELECT * FROM report_versions WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY created_at, id`,
      args: testArgs,
    },
  ];

  const entries = await Promise.all(queries.map((query) => queryRows(db, query)));
  const data = Object.fromEntries(
    DATA_SUBJECT_EXPORT_SECTIONS.map((section) => [section, []]),
  ) as unknown as Record<DataSubjectExportSection, DataSubjectExportRow[]>;
  data.athletes = [{ ...athlete }];
  for (const [section, rows] of entries) data[section] = rows;

  const reportArtifacts = data.report_versions.flatMap((row) => {
    const reportVersionId = row.id;
    const storageReference = row.storage_reference;
    if (typeof reportVersionId !== 'string' || typeof storageReference !== 'string') return [];
    return [{
      reportVersionId,
      storageReference,
      mediaType: 'application/pdf' as const,
    }];
  });

  return Object.freeze({
    tenantId,
    athleteId,
    data: Object.freeze(data),
    reportArtifacts: Object.freeze(reportArtifacts.map((artifact) => Object.freeze(artifact))),
  });
}
