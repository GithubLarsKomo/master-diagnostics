import type { TestExportDocument } from './test-export';

export interface AnalysisExportMeasurement {
  kind: 'REST' | 'STAGE' | 'RECOVERY';
  stageNumber: number | null;
  targetWatts: number | null;
  actualSeconds: number | null;
  heartRate: number | null;
  lactateValueX100: number | null;
  lactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  qualityStatus: string | null;
}

export interface AnonymizedAnalysisExport {
  schemaVersion: 'masters-analysis-export-v1';
  testYear: number;
  status: string;
  deviceType: string;
  protocolVersion: string;
  measurements: readonly AnalysisExportMeasurement[];
}

function parseTestYear(testDate: string): number {
  const parsed = new Date(testDate);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Test date is invalid');
  return parsed.getUTCFullYear();
}

/**
 * Produces an analysis-focused export that intentionally removes direct and
 * stable indirect identifiers from the regular test export. It does not carry
 * athlete/test/trainer IDs or names, exact dates, measurement timestamps,
 * free-text notes, or any cross-export subject key.
 */
export function createAnonymizedAnalysisExport(
  source: TestExportDocument,
): Readonly<AnonymizedAnalysisExport> {
  return Object.freeze({
    schemaVersion: 'masters-analysis-export-v1',
    testYear: parseTestYear(source.metadata.testDate),
    status: source.metadata.status,
    deviceType: source.metadata.deviceType,
    protocolVersion: source.metadata.protocolVersion,
    measurements: Object.freeze(source.measurements.map((row) => Object.freeze({
      kind: row.kind,
      stageNumber: row.stageNumber,
      targetWatts: row.targetWatts,
      actualSeconds: row.actualSeconds,
      heartRate: row.heartRate,
      lactateValueX100: row.lactateValueX100,
      lactateQualifier: row.lactateQualifier,
      qualityStatus: row.qualityStatus,
    }))),
  });
}

export function renderAnonymizedAnalysisExportJson(
  document: AnonymizedAnalysisExport,
): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
