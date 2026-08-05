import { describe, expect, it } from 'vitest';
import {
  DATA_SUBJECT_EXPORT_SCHEMA_VERSION,
  DATA_SUBJECT_EXPORT_SECTIONS,
  createAthleteDataSubjectExportDocument,
  renderAthleteDataSubjectExportJson,
  type AthleteDataSubjectExportSource,
} from '../src/data-subject-export';

function emptySource(): AthleteDataSubjectExportSource {
  return {
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    data: Object.fromEntries(DATA_SUBJECT_EXPORT_SECTIONS.map((section) => [section, []])) as AthleteDataSubjectExportSource['data'],
    reportArtifacts: [],
  };
}

describe('data subject export contract', () => {
  it('creates a deterministic versioned document without dropping empty sections', () => {
    const source = emptySource();
    source.data.athletes.push({ id: 'athlete-a', first_name: 'Petra' });
    source.reportArtifacts.push({
      reportVersionId: 'report-a',
      storageReference: 'tenant-a/test-a/de/report-a.pdf',
      mediaType: 'application/pdf',
    });

    const document = createAthleteDataSubjectExportDocument(
      source,
      '2026-08-05T18:00:00.000Z',
    );

    expect(document.schemaVersion).toBe(DATA_SUBJECT_EXPORT_SCHEMA_VERSION);
    expect(Object.keys(document.data)).toEqual([...DATA_SUBJECT_EXPORT_SECTIONS]);
    expect(document.data.athletes).toEqual([{ id: 'athlete-a', first_name: 'Petra' }]);
    expect(document.data.tests).toEqual([]);
    expect(document.reportArtifacts).toHaveLength(1);
    expect(renderAthleteDataSubjectExportJson(document)).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it('fails closed for an invalid export timestamp', () => {
    expect(() => createAthleteDataSubjectExportDocument(emptySource(), 'not-a-date')).toThrow(
      /valid ISO-8601 timestamp/,
    );
  });
});
