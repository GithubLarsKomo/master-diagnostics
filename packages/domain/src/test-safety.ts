export const TEST_START_SAFETY_CHECKLIST_VERSION = 'TEST_START_SAFETY_V1';

export const TEST_START_SAFETY_CHECKLIST_ITEMS = [
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
] as const;

export type TestStartSafetyChecklistItem =
  (typeof TEST_START_SAFETY_CHECKLIST_ITEMS)[number];

export type TestStartSafetyChecklistConfirmation =
  Record<TestStartSafetyChecklistItem, boolean>;

export function getMissingTestStartSafetyItems(
  confirmation: Partial<TestStartSafetyChecklistConfirmation>,
): TestStartSafetyChecklistItem[] {
  return TEST_START_SAFETY_CHECKLIST_ITEMS.filter(
    (item) => confirmation[item] !== true,
  );
}
