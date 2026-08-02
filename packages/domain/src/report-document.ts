export type ReportLocale = 'de' | 'en';

export interface ReportDocumentInput {
  athleteName: string;
  testDate: string;
  trainerName: string;
  tenantName: string;
  deviceType: string;
  protocolVersion: string;
  reportVersion: number;
  releasedAt: string;
  lt1Watts?: number | null;
  lt2Watts?: number | null;
  trainerComment?: string | null;
}

export interface ReportDocumentField {
  readonly label: string;
  readonly value: string;
}

export interface ReportDocumentSection {
  readonly heading: string;
  readonly fields: readonly ReportDocumentField[];
}

export interface ReportDocument {
  readonly locale: ReportLocale;
  readonly title: string;
  readonly sections: readonly ReportDocumentSection[];
  readonly disclaimer: string;
}

const labels = {
  de: {
    title: 'Leistungsdiagnostischer Bericht',
    overview: 'Testübersicht',
    results: 'Schwellen',
    athlete: 'Athlet',
    testDate: 'Testdatum',
    trainer: 'Trainer',
    tenant: 'Organisation',
    device: 'Gerät',
    protocol: 'Protokollversion',
    version: 'Berichtsversion',
    releasedAt: 'Freigabezeitpunkt',
    lt1: 'LT1',
    lt2: 'LT2',
    comment: 'Trainerkommentar',
    missing: 'Nicht verfügbar',
    disclaimer: 'Dieser Bericht dient der Trainingssteuerung und ist kein Medizinprodukt.',
  },
  en: {
    title: 'Performance Diagnostic Report',
    overview: 'Test overview',
    results: 'Thresholds',
    athlete: 'Athlete',
    testDate: 'Test date',
    trainer: 'Trainer',
    tenant: 'Organisation',
    device: 'Device',
    protocol: 'Protocol version',
    version: 'Report version',
    releasedAt: 'Release time',
    lt1: 'LT1',
    lt2: 'LT2',
    comment: 'Trainer comment',
    missing: 'Not available',
    disclaimer: 'This report is intended for training guidance and is not a medical device.',
  },
} as const;

function watts(value: number | null | undefined, missing: string): string {
  return value == null ? missing : `${value} W`;
}

function field(label: string, value: string): ReportDocumentField {
  return Object.freeze({ label, value });
}

function freezeSection(heading: string, fields: readonly ReportDocumentField[]): ReportDocumentSection {
  return Object.freeze({ heading, fields: Object.freeze([...fields]) });
}

export function buildReportDocument(locale: ReportLocale, input: ReportDocumentInput): ReportDocument {
  const text = labels[locale];
  const overview = freezeSection(text.overview, [
    field(text.athlete, input.athleteName),
    field(text.testDate, input.testDate),
    field(text.trainer, input.trainerName),
    field(text.tenant, input.tenantName),
    field(text.device, input.deviceType),
    field(text.protocol, input.protocolVersion),
    field(text.version, String(input.reportVersion)),
    field(text.releasedAt, input.releasedAt),
  ]);
  const resultFields = [
    field(text.lt1, watts(input.lt1Watts, text.missing)),
    field(text.lt2, watts(input.lt2Watts, text.missing)),
  ];
  if (input.trainerComment?.trim()) {
    resultFields.push(field(text.comment, input.trainerComment.trim()));
  }
  const results = freezeSection(text.results, resultFields);

  return Object.freeze({
    locale,
    title: text.title,
    sections: Object.freeze([overview, results]),
    disclaimer: text.disclaimer,
  });
}
