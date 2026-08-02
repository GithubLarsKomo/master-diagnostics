import { describe, expect, it } from 'vitest';
import {
  createAnonymizedAnalysisExport,
  createTestExportDocument,
  renderAnonymizedAnalysisExportJson,
} from '../src';

function source() {
  return createTestExportDocument({
    testId: 'test-secret-id',
    athleteName: 'Max Mustermann',
    testDate: '2026-08-02T14:22:00.000Z',
    status: 'RELEASED',
    deviceType: 'ROWERG',
    protocolVersion: 'rowing-v3',
    trainerName: 'Erika Trainerin',
  }, [{
    kind: 'STAGE',
    stageNumber: 1,
    targetWatts: 220,
    actualSeconds: 240,
    heartRate: 142,
    lactateValueX100: 245,
    lactateQualifier: 'EXACT',
    measuredAt: '2026-08-02T14:30:11.000Z',
    qualityStatus: 'VALID',
    notes: 'Seltene freie Notiz mit Personenbezug',
  }]);
}

describe('anonymized analysis export', () => {
  it('keeps analysis values while removing direct identifiers and exact timestamps', () => {
    const document = createAnonymizedAnalysisExport(source());
    const json = renderAnonymizedAnalysisExportJson(document);

    expect(document.schemaVersion).toBe('masters-analysis-export-v1');
    expect(document.testYear).toBe(2026);
    expect(document.measurements[0]).toMatchObject({
      kind: 'STAGE', stageNumber: 1, targetWatts: 220, heartRate: 142, lactateValueX100: 245,
    });
    expect(json).not.toContain('test-secret-id');
    expect(json).not.toContain('Max Mustermann');
    expect(json).not.toContain('Erika Trainerin');
    expect(json).not.toContain('2026-08-02T14:22:00.000Z');
    expect(json).not.toContain('2026-08-02T14:30:11.000Z');
    expect(json).not.toContain('Seltene freie Notiz');
  });

  it('does not expose a stable subject key and freezes nested measurements', () => {
    const document = createAnonymizedAnalysisExport(source());
    expect('athleteId' in document).toBe(false);
    expect('subjectId' in document).toBe(false);
    expect('testId' in document).toBe(false);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.measurements)).toBe(true);
    expect(Object.isFrozen(document.measurements[0])).toBe(true);
  });

  it('rejects invalid test dates rather than leaking a fallback value', () => {
    const invalid = createTestExportDocument({
      ...source().metadata,
      testDate: 'not-a-date',
    }, source().measurements);
    expect(() => createAnonymizedAnalysisExport(invalid)).toThrow('Test date is invalid');
  });
});
