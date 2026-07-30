import {
  evaluateMeasurementPlausibility,
  type MeasurementPlausibilityWarning,
} from '@masters/domain';
import type { TestReviewRow } from '@masters/db';

export function getReviewPlausibilityWarnings(
  rows: readonly TestReviewRow[],
): MeasurementPlausibilityWarning[] {
  return evaluateMeasurementPlausibility(rows);
}
