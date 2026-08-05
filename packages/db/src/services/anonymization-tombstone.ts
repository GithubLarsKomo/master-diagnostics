export const ATHLETE_TOMBSTONE_VERSION = 1 as const;
export const ATHLETE_TOMBSTONE_TEXT = '[ANONYMIZED]' as const;
export const ATHLETE_TOMBSTONE_DATE = '0001-01-01' as const;

export interface AthleteTombstoneV1 {
  linkedUserId: null;
  firstName: typeof ATHLETE_TOMBSTONE_TEXT;
  lastName: typeof ATHLETE_TOMBSTONE_TEXT;
  birthDate: typeof ATHLETE_TOMBSTONE_DATE;
  referenceCategory: typeof ATHLETE_TOMBSTONE_TEXT;
  heightCm: 0;
  currentWeightKgX100: 0;
  primarySport: typeof ATHLETE_TOMBSTONE_TEXT;
  primaryDiscipline: typeof ATHLETE_TOMBSTONE_TEXT;
  trainingStatus: typeof ATHLETE_TOMBSTONE_TEXT;
}

/**
 * Returns the deterministic minimal profile representation used only after an
 * athlete has already been soft-deleted and passed the irreversible-processing
 * gates. Zero dimensions and year 0001 are deliberate non-physiological
 * sentinels, not plausible replacement data.
 *
 * Normal athlete create/update validation must never be relaxed to accept these
 * values; deleted athletes are already excluded from those normal access paths.
 */
export function athleteTombstoneV1(): Readonly<AthleteTombstoneV1> {
  return Object.freeze({
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
}
