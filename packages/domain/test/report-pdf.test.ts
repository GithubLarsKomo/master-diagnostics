import { describe, expect, it } from 'vitest';
import { buildReportDocument } from '../src/report-document';
import { renderReportPdf } from '../src/report-pdf';

const input = {
  athleteName: 'Max Müller',
  testDate: '2026-08-02',
  trainerName: 'Trainer Test',
  tenantName: 'Ruderclub Test',
  deviceType: 'ROWERG',
  protocolVersion: '3',
  reportVersion: 2,
  releasedAt: '2026-08-02T14:00:00.000Z',
  lt1Watts: 245,
  lt2Watts: 310,
  trainerComment: 'Stabile Entwicklung',
} as const;

function decodeLatin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

describe('report PDF renderer', () => {
  it.each([
    ['de', 'Leistungsdiagnostischer Bericht', 'Athlet: Max Müller'],
    ['en', 'Performance Diagnostic Report', 'Athlete: Max Müller'],
  ] as const)('renders a valid %s PDF with localized content', (locale, title, athleteLine) => {
    const bytes = renderReportPdf(buildReportDocument(locale, input));
    const pdf = decodeLatin1(bytes);

    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain(title);
    expect(pdf).toContain(athleteLine);
    expect(pdf).toContain('LT1: 245 W');
    expect(pdf).toContain('LT2: 310 W');
    expect(pdf).toContain('xref\n');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('is byte-deterministic for the same document', () => {
    const document = buildReportDocument('de', input);
    expect(renderReportPdf(document)).toEqual(renderReportPdf(document));
  });
});
