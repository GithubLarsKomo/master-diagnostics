import { describe, expect, it } from 'vitest';
import { assessAthleteRetention } from '../src';

describe('athlete retention assessment', () => {
  it('uses the latest test and tenant retention period', () => {
    expect(assessAthleteRetention({
      athleteCreatedAt: '2020-01-01T00:00:00.000Z',
      linkedUserId: null,
      testReferenceTimes: [
        '2024-02-01T10:00:00.000Z',
        '2025-03-15T12:30:00.000Z',
      ],
      assessedAt: '2027-03-15T12:29:59.000Z',
    }, { tenantRetentionYears: 2 })).toEqual({
      basis: 'LAST_TEST',
      reason: 'RETENTION_ACTIVE',
      tenantRetentionYears: 2,
      referenceAt: '2025-03-15T12:30:00.000Z',
      retainUntil: '2027-03-15T12:30:00.000Z',
      eligibleForIrreversibleAction: false,
    });

    expect(assessAthleteRetention({
      athleteCreatedAt: '2020-01-01T00:00:00.000Z',
      linkedUserId: null,
      testReferenceTimes: ['2025-03-15T12:30:00.000Z'],
      assessedAt: '2027-03-15T12:30:00.000Z',
    }, { tenantRetentionYears: 2 })).toMatchObject({
      reason: 'RETENTION_EXPIRED',
      eligibleForIrreversibleAction: true,
    });
  });

  it('retains managed profiles without tests for twelve months', () => {
    expect(assessAthleteRetention({
      athleteCreatedAt: '2026-04-10T08:00:00.000Z',
      linkedUserId: null,
      testReferenceTimes: [],
      assessedAt: '2027-04-10T08:00:00.000Z',
    }, { tenantRetentionYears: 10 })).toEqual({
      basis: 'MANAGED_PROFILE_NO_TEST',
      reason: 'RETENTION_EXPIRED',
      tenantRetentionYears: 10,
      referenceAt: '2026-04-10T08:00:00.000Z',
      retainUntil: '2027-04-10T08:00:00.000Z',
      eligibleForIrreversibleAction: true,
    });
  });

  it('fails closed for linked profiles without tests', () => {
    expect(assessAthleteRetention({
      athleteCreatedAt: '2020-01-01T00:00:00.000Z',
      linkedUserId: 'user-a',
      testReferenceTimes: [],
      assessedAt: '2030-01-01T00:00:00.000Z',
    }, { tenantRetentionYears: 1 })).toEqual({
      basis: 'MANUAL_REVIEW',
      reason: 'MANUAL_REVIEW_REQUIRED',
      tenantRetentionYears: 1,
      referenceAt: '2020-01-01T00:00:00.000Z',
      retainUntil: null,
      eligibleForIrreversibleAction: false,
    });
  });

  it('clamps leap-day anniversaries to the last valid calendar day', () => {
    expect(assessAthleteRetention({
      athleteCreatedAt: '2020-01-01T00:00:00.000Z',
      linkedUserId: null,
      testReferenceTimes: ['2024-02-29T18:45:00.000Z'],
      assessedAt: '2025-02-28T18:45:00.000Z',
    }, { tenantRetentionYears: 1 })).toMatchObject({
      retainUntil: '2025-02-28T18:45:00.000Z',
      eligibleForIrreversibleAction: true,
    });
  });

  it('rejects invalid retention policy and timestamps', () => {
    expect(() => assessAthleteRetention({
      athleteCreatedAt: '2026-01-01T00:00:00.000Z',
      linkedUserId: null,
      testReferenceTimes: [],
      assessedAt: '2026-01-01T00:00:00.000Z',
    }, { tenantRetentionYears: 0 })).toThrow('between 1 and 10');

    expect(() => assessAthleteRetention({
      athleteCreatedAt: 'invalid',
      linkedUserId: null,
      testReferenceTimes: [],
      assessedAt: '2026-01-01T00:00:00.000Z',
    }, { tenantRetentionYears: 1 })).toThrow('Athlete creation time');
  });
});
