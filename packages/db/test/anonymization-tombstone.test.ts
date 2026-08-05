import { describe, expect, it } from 'vitest';
import {
  ATHLETE_TOMBSTONE_DATE,
  ATHLETE_TOMBSTONE_TEXT,
  ATHLETE_TOMBSTONE_VERSION,
  athleteTombstoneV1,
} from '../src/services/anonymization-tombstone';

describe('athlete anonymization tombstone v1', () => {
  it('uses explicit non-personal sentinels for every mutable profile attribute', () => {
    expect(ATHLETE_TOMBSTONE_VERSION).toBe(1);
    expect(athleteTombstoneV1()).toEqual({
      linkedUserId: null,
      firstName: ATHLETE_TOMBSTONE_TEXT,
      lastName: ATHLETE_TOMBSTONE_TEXT,
      birthDate: ATHLETE_TOMBSTONE_DATE,
      referenceCategory: ATHLETE_TOMBSTONE_TEXT,
      heightCm: 0,
      currentWeightKgX100: 0,
      primarySport: ATHLETE_TOMBSTONE_TEXT,
      primaryDiscipline: ATHLETE_TOMBSTONE_TEXT,
      trainingStatus: ATHLETE_TOMBSTONE_TEXT,
    });
  });

  it('is deterministic, immutable and contains no plausible physiological replacement values', () => {
    const first = athleteTombstoneV1();
    const second = athleteTombstoneV1();
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.birthDate).toBe('0001-01-01');
    expect(first.heightCm).toBe(0);
    expect(first.currentWeightKgX100).toBe(0);
    expect(JSON.stringify(first)).not.toContain('Petra');
    expect(JSON.stringify(first)).not.toContain('ROWING');
  });
});
