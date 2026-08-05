import { describe, expect, it } from 'vitest';
import {
  DATA_SUBJECT_EXPORT_SECTIONS,
  type AthleteDataSubjectExportSource,
} from '../src/data-subject-export';
import {
  DATA_SUBJECT_REVIEW_REQUIRED,
  DATA_SUBJECT_THIRD_PARTY_REDACTION,
  projectAthleteDataSubjectExportForDelivery,
} from '../src/data-subject-delivery';

function emptyData(): AthleteDataSubjectExportSource['data'] {
  return Object.fromEntries(DATA_SUBJECT_EXPORT_SECTIONS.map((section) => [section, []])) as unknown as AthleteDataSubjectExportSource['data'];
}

function sourceWithThirdPartyAndFreeText(): AthleteDataSubjectExportSource {
  return {
    tenantId: 'tenant-a',
    athleteId: 'athlete-a',
    data: {
      ...emptyData(),
      athletes: [{ id: 'athlete-a', linked_user_id: 'athlete-user-a', first_name: 'Petra' }],
      athlete_guardians: [{
        id: 'guardian-a', athlete_id: 'athlete-a', full_name: 'Erika Muster',
        email: 'erika@example.test', phone: '+491111111', relationship: 'parent',
      }],
      coach_athlete_assignments: [{
        id: 'assignment-a', athlete_id: 'athlete-a', coach_user_id: 'coach-a', is_primary: 1,
      }],
      tests: [{
        id: 'test-a', athlete_id: 'athlete-a', conducting_trainer_user_id: 'coach-a', status: 'RELEASED',
      }],
      test_termination_events: [{
        id: 'termination-a', test_id: 'test-a', reason: 'REGULAR_EXHAUSTION',
        notes: 'Discussed with Dr. Schmidt', ended_by_user_id: 'coach-a',
      }],
      measurement_corrections: [{
        id: 'correction-a', test_id: 'test-a', reason: 'Coach Schmidt requested correction',
        corrected_by_user_id: 'coach-a',
      }],
      interpretations: [{
        id: 'interpretation-a', test_id: 'test-a', rationale: 'Discussed with Dr. Schmidt',
        released_by_user_id: 'coach-a',
      }],
    },
    reportArtifacts: [{
      reportVersionId: 'report-a', storageReference: 'tenant-a/test-a/de/report-a.pdf', mediaType: 'application/pdf',
    }],
  };
}

describe('data subject delivery projection', () => {
  it('redacts structured third-party identifiers and withholds free text until review', () => {
    const projection = projectAthleteDataSubjectExportForDelivery(sourceWithThirdPartyAndFreeText());

    expect(projection.readyForDelivery).toBe(false);
    expect(projection.projectedSource.data.athletes[0]?.linked_user_id).toBe('athlete-user-a');
    expect(projection.projectedSource.data.athlete_guardians[0]).toMatchObject({
      full_name: DATA_SUBJECT_THIRD_PARTY_REDACTION,
      email: DATA_SUBJECT_THIRD_PARTY_REDACTION,
      phone: DATA_SUBJECT_THIRD_PARTY_REDACTION,
      relationship: 'parent',
    });
    expect(projection.projectedSource.data.coach_athlete_assignments[0]?.coach_user_id)
      .toBe(DATA_SUBJECT_THIRD_PARTY_REDACTION);
    expect(projection.projectedSource.data.tests[0]?.conducting_trainer_user_id)
      .toBe(DATA_SUBJECT_THIRD_PARTY_REDACTION);
    expect(projection.projectedSource.data.test_termination_events[0]?.ended_by_user_id)
      .toBe(DATA_SUBJECT_THIRD_PARTY_REDACTION);
    expect(projection.projectedSource.data.test_termination_events[0]?.notes)
      .toBe(DATA_SUBJECT_REVIEW_REQUIRED);
    expect(projection.projectedSource.data.measurement_corrections[0]?.reason)
      .toBe(DATA_SUBJECT_REVIEW_REQUIRED);
    expect(projection.projectedSource.data.interpretations[0]?.rationale)
      .toBe(DATA_SUBJECT_REVIEW_REQUIRED);

    expect(projection.reviewItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: 'test_termination_events', rowId: 'termination-a', field: 'reason' }),
      expect.objectContaining({ section: 'test_termination_events', rowId: 'termination-a', field: 'notes' }),
      expect.objectContaining({ section: 'measurement_corrections', rowId: 'correction-a', field: 'reason' }),
      expect.objectContaining({ section: 'interpretations', rowId: 'interpretation-a', field: 'rationale' }),
    ]));

    const serialized = JSON.stringify(projection.projectedSource);
    expect(serialized).not.toContain('Erika Muster');
    expect(serialized).not.toContain('erika@example.test');
    expect(serialized).not.toContain('+491111111');
    expect(serialized).not.toContain('coach-a');
    expect(serialized).not.toContain('Dr. Schmidt');
    expect(serialized).toContain('athlete-user-a');
    expect(projection.projectedSource.reportArtifacts).toEqual(sourceWithThirdPartyAndFreeText().reportArtifacts);
  });

  it('marks a source without third-party identifiers or free text ready for the next delivery stage', () => {
    const source: AthleteDataSubjectExportSource = {
      tenantId: 'tenant-a',
      athleteId: 'athlete-a',
      data: {
        ...emptyData(),
        athletes: [{ id: 'athlete-a', linked_user_id: 'athlete-user-a', first_name: 'Petra' }],
      },
      reportArtifacts: [],
    };

    const projection = projectAthleteDataSubjectExportForDelivery(source);
    expect(projection.readyForDelivery).toBe(true);
    expect(projection.automaticRedactions).toEqual([]);
    expect(projection.reviewItems).toEqual([]);
  });
});
