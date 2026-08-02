export type TestExportFormat = 'csv' | 'json' | 'markdown';

export interface TestExportMetadata {
  testId: string;
  athleteName: string;
  testDate: string;
  status: string;
  deviceType: string;
  protocolVersion: string;
  trainerName: string;
}

export interface TestExportMeasurement {
  kind: 'REST' | 'STAGE' | 'RECOVERY';
  stageNumber: number | null;
  targetWatts: number | null;
  actualSeconds: number | null;
  heartRate: number | null;
  lactateValueX100: number | null;
  lactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  measuredAt: string | null;
  qualityStatus: string | null;
  notes: string | null;
}

export interface TestExportDocument {
  schemaVersion: 'masters-test-export-v1';
  metadata: TestExportMetadata;
  measurements: readonly TestExportMeasurement[];
}

export function createTestExportDocument(
  metadata: TestExportMetadata,
  measurements: readonly TestExportMeasurement[],
): Readonly<TestExportDocument> {
  return Object.freeze({
    schemaVersion: 'masters-test-export-v1',
    metadata: Object.freeze({ ...metadata }),
    measurements: Object.freeze(measurements.map((row) => Object.freeze({ ...row }))),
  });
}

function scalar(value: string | number | null): string {
  return value === null ? '' : String(value);
}

function csvCell(value: string | number | null): string {
  const text = scalar(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const measurementColumns = [
  'kind',
  'stageNumber',
  'targetWatts',
  'actualSeconds',
  'heartRate',
  'lactateMmolL',
  'lactateQualifier',
  'measuredAt',
  'qualityStatus',
  'notes',
] as const;

function measurementValues(row: TestExportMeasurement): Array<string | number | null> {
  return [
    row.kind,
    row.stageNumber,
    row.targetWatts,
    row.actualSeconds,
    row.heartRate,
    row.lactateValueX100 === null ? null : (row.lactateValueX100 / 100).toFixed(2),
    row.lactateQualifier,
    row.measuredAt,
    row.qualityStatus,
    row.notes,
  ];
}

export function renderTestExportCsv(document: TestExportDocument): string {
  const metadataRows: Array<[string, string]> = [
    ['schemaVersion', document.schemaVersion],
    ['testId', document.metadata.testId],
    ['athleteName', document.metadata.athleteName],
    ['testDate', document.metadata.testDate],
    ['status', document.metadata.status],
    ['deviceType', document.metadata.deviceType],
    ['protocolVersion', document.metadata.protocolVersion],
    ['trainerName', document.metadata.trainerName],
  ];
  const lines = [
    'field,value',
    ...metadataRows.map(([field, value]) => `${csvCell(field)},${csvCell(value)}`),
    '',
    measurementColumns.join(','),
    ...document.measurements.map((row) => measurementValues(row).map(csvCell).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function renderTestExportJson(document: TestExportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function markdownCell(value: string | number | null): string {
  return scalar(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

export function renderTestExportMarkdown(document: TestExportDocument): string {
  const metadata = document.metadata;
  const rows = document.measurements.map((row) => (
    `| ${measurementValues(row).map(markdownCell).join(' | ')} |`
  ));
  return [
    '# Testexport',
    '',
    `- Schema: ${document.schemaVersion}`,
    `- Test-ID: ${metadata.testId}`,
    `- Athlet: ${metadata.athleteName}`,
    `- Testdatum: ${metadata.testDate}`,
    `- Status: ${metadata.status}`,
    `- Gerät: ${metadata.deviceType}`,
    `- Protokollversion: ${metadata.protocolVersion}`,
    `- Trainer: ${metadata.trainerName}`,
    '',
    '## Messwerte',
    '',
    `| ${measurementColumns.join(' | ')} |`,
    `| ${measurementColumns.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
  ].join('\n');
}

export function renderTestExport(document: TestExportDocument, format: TestExportFormat): string {
  if (format === 'csv') return renderTestExportCsv(document);
  if (format === 'json') return renderTestExportJson(document);
  return renderTestExportMarkdown(document);
}
