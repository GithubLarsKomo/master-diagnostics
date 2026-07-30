import { describe, expect, it } from 'vitest';
import {
  getMissingTestStartSafetyItems,
  TEST_START_SAFETY_CHECKLIST_ITEMS,
  TEST_START_SAFETY_CHECKLIST_VERSION,
  type TestStartSafetyChecklistConfirmation,
} from '../src/test-safety';

describe('test start safety checklist', () => {
  it('keeps the specification checklist versioned and complete', () => {
    expect(TEST_START_SAFETY_CHECKLIST_VERSION).toBe('TEST_START_SAFETY_V1');
    expect(TEST_START_SAFETY_CHECKLIST_ITEMS).toHaveLength(11);
    expect(TEST_START_SAFETY_CHECKLIST_ITEMS).toEqual([
      'identityVerified',
      'consentValid',
      'deviceTypeVerified',
      'testPlanVerified',
      'athleteInformed',
      'subjectiveReadinessConfirmed',
      'currentComplaintsAsked',
      'measurementEquipmentReady',
      'emergencyProceduresKnown',
      'sensorValuesPlausibleOrNotConnected',
      'trainerResponsibilityAccepted',
    ]);
  });

  it('returns every missing or unconfirmed item', () => {
    const complete = Object.fromEntries(
      TEST_START_SAFETY_CHECKLIST_ITEMS.map((item) => [item, true]),
    ) as TestStartSafetyChecklistConfirmation;

    expect(getMissingTestStartSafetyItems(complete)).toEqual([]);
    expect(getMissingTestStartSafetyItems({
      ...complete,
      consentValid: false,
      currentComplaintsAsked: false,
    })).toEqual(['consentValid', 'currentComplaintsAsked']);
  });
});
