import { describe, expect, it } from 'vitest';
import {
  createTestExportDocument,
  renderTestExportCsv,
  renderTestExportJson,
  renderTestExportMarkdown,
} from '../src/test-export';

const document = createTestExportDocument(
  {
    testId: 'test-1',
    athleteName: 'Max Müller',
    testDate: '2026-08-02T12:00:00.000Z',
    status: 'RELEASED',
    deviceType: 'ROWERG',
    protocolVersion: '3',
    trainerName: 'Anna Trainer',
  },
  [
    {
      kind: 'REST',
      stageNumber: null,
      targetWatts: null,
      actualSeconds: null,
      heartRate: 52,
      lactateValueX100: 95,
      lactateQualifier: 'EXACT',
      measuredAt: '2026-08-02T11:59:00.000Z',
      qualityStatus: null,
      notes: null,
    },
    {
      kind: 'STAGE',
      stageNumber: 1,
      targetWatts: 180,
      actualSeconds: 240,
      heartRate: 128,
      lactateValueX100: 250,
      lactateQualifier: 'EXACT',
      measuredAt: '2026-08-02T12:05:00.000Z',
      qualityStatus: 'MANUALLY_CORRECTED',
      notes: 'Papier, geprüft',
    },
  ],
);

describe('test export', () => {
  it('creates immutable export documents', () => {
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.metadata)).toBe(true);
    expect(Object.isFrozen(document.measurements)).toBe(true);
    expect(Object.isFrozen(document.measurements[0])).toBe(true);
  });

  it('renders valid deterministic JSON', () => {
    const json = renderTestExportJson(document);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(document);
  });

  it('renders CSV with decimal lactate and escaped cells', () => {
    const csv = renderTestExportCsv(document);
    expect(csv).toContain('schemaVersion,masters-test-export-v1');
    expect(csv).toContain('STAGE,1,180,240,128,2.50,EXACT');
    expect(csv).toContain('"Papier, geprüft"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('renders Markdown from the same measurement model', () => {
    const markdown = renderTestExportMarkdown(document);
    expect(markdown).toContain('# Testexport');
    expect(markdown).toContain('- Athlet: Max Müller');
    expect(markdown).toContain('| STAGE | 1 | 180 | 240 | 128 | 2.50 | EXACT |');
  });
});
