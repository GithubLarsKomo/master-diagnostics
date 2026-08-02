import { describe, expect, it } from 'vitest';
import { buildReportDocument } from '../src/report-document';

const input = {
  athleteName: 'Max Test',
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

describe('bilingual report document', () => {
  it('builds the German report labels and values', () => {
    const report = buildReportDocument('de', input);
    expect(report.title).toBe('Leistungsdiagnostischer Bericht');
    expect(report.sections[0]?.heading).toBe('Testübersicht');
    expect(report.sections[0]?.fields.map((entry) => entry.value)).toContain('Max Test');
    expect(report.sections[1]?.fields).toContainEqual({ label: 'LT2', value: '310 W' });
    expect(report.sections[1]?.fields).toContainEqual({ label: 'Trainerkommentar', value: 'Stabile Entwicklung' });
    expect(report.disclaimer).toContain('kein Medizinprodukt');
  });

  it('builds English labels without changing diagnostic values', () => {
    const report = buildReportDocument('en', input);
    expect(report.title).toBe('Performance Diagnostic Report');
    expect(report.sections[0]?.heading).toBe('Test overview');
    expect(report.sections[1]?.fields).toContainEqual({ label: 'LT1', value: '245 W' });
    expect(report.sections[1]?.fields).toContainEqual({ label: 'Trainer comment', value: 'Stabile Entwicklung' });
    expect(report.disclaimer).toContain('not a medical device');
  });

  it('returns detached immutable report structures and localized missing values', () => {
    const report = buildReportDocument('en', { ...input, lt2Watts: null, trainerComment: '   ' });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sections)).toBe(true);
    expect(Object.isFrozen(report.sections[0])).toBe(true);
    expect(report.sections[1]?.fields).toContainEqual({ label: 'LT2', value: 'Not available' });
    expect(report.sections[1]?.fields.some((entry) => entry.label === 'Trainer comment')).toBe(false);
  });
});
