export const DATA_SUBJECT_EXPORT_SCHEMA_VERSION = 'masters-data-subject-export-v1' as const;

export const DATA_SUBJECT_EXPORT_SECTIONS = [
  'athletes',
  'athlete_snapshots',
  'coach_athlete_assignments',
  'consents',
  'athlete_guardians',
  'athlete_deletion_requests',
  'tests',
  'test_plan_snapshots',
  'test_safety_checklist_confirmations',
  'test_termination_events',
  'test_stages',
  'rest_measurements',
  'recovery_measurements',
  'quality_flags',
  'measurement_corrections',
  'threshold_runs',
  'threshold_results',
  'diagnostic_result_snapshots',
  'interpretations',
  'zone_profiles',
  'report_versions',
] as const;

export type DataSubjectExportSection = (typeof DATA_SUBJECT_EXPORT_SECTIONS)[number];
export type DataSubjectExportRow = Readonly<Record<string, unknown>>;

export interface DataSubjectExportReportArtifactReference {
  reportVersionId: string;
  storageReference: string;
  mediaType: 'application/pdf';
}

export interface AthleteDataSubjectExportSource {
  tenantId: string;
  athleteId: string;
  data: Readonly<Record<DataSubjectExportSection, readonly DataSubjectExportRow[]>>;
  reportArtifacts: readonly Readonly<DataSubjectExportReportArtifactReference>[];
}

export interface AthleteDataSubjectExportDocument extends AthleteDataSubjectExportSource {
  schemaVersion: typeof DATA_SUBJECT_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
}

function copyRows(rows: readonly DataSubjectExportRow[]): readonly DataSubjectExportRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

export function createAthleteDataSubjectExportDocument(
  source: Readonly<AthleteDataSubjectExportSource>,
  exportedAt: string,
): Readonly<AthleteDataSubjectExportDocument> {
  if (!Number.isFinite(Date.parse(exportedAt))) {
    throw new Error('Export time must be a valid ISO-8601 timestamp');
  }

  const data = Object.fromEntries(DATA_SUBJECT_EXPORT_SECTIONS.map((section) => [
    section,
    copyRows(source.data[section] ?? []),
  ])) as Record<DataSubjectExportSection, readonly DataSubjectExportRow[]>;

  return Object.freeze({
    schemaVersion: DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
    exportedAt,
    tenantId: source.tenantId,
    athleteId: source.athleteId,
    data: Object.freeze(data),
    reportArtifacts: Object.freeze(source.reportArtifacts.map((artifact) => Object.freeze({ ...artifact }))),
  });
}

export function renderAthleteDataSubjectExportJson(
  document: Readonly<AthleteDataSubjectExportDocument>,
): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
