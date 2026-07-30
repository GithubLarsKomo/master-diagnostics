export type LactateQualifier = 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';

export interface PlausibilityMeasurement {
  kind: 'REST' | 'STAGE' | 'RECOVERY';
  stageNumber: number | null;
  heartRate: number | null;
  lactateValueX100: number | null;
  lactateQualifier: LactateQualifier | null;
  qualityStatus?: 'VALID' | 'PARTIAL' | 'EXCLUDED' | 'MISSING' | 'MANUALLY_CORRECTED' | null;
}

export type MeasurementPlausibilityCode =
  | 'LACTATE_DROP'
  | 'HEART_RATE_DROP'
  | 'BOUNDARY_QUALIFIER'
  | 'MISSING_STAGE_VALUE';

export interface MeasurementPlausibilityWarning {
  code: MeasurementPlausibilityCode;
  severity: 'INFO' | 'WARNING';
  stageNumber: number | null;
  message: string;
}

const LACTATE_DROP_X100 = 50;
const HEART_RATE_DROP_BPM = 10;

function isIncludedStage(measurement: PlausibilityMeasurement): boolean {
  return measurement.kind === 'STAGE'
    && measurement.qualityStatus !== 'EXCLUDED'
    && measurement.qualityStatus !== 'MISSING';
}

export function evaluateMeasurementPlausibility(
  measurements: readonly PlausibilityMeasurement[],
): MeasurementPlausibilityWarning[] {
  const warnings: MeasurementPlausibilityWarning[] = [];
  const stages = measurements
    .filter(isIncludedStage)
    .sort((left, right) => (left.stageNumber ?? 0) - (right.stageNumber ?? 0));

  let previousExactLactate: PlausibilityMeasurement | null = null;
  let previousHeartRate: PlausibilityMeasurement | null = null;

  for (const stage of stages) {
    if (
      stage.lactateValueX100 === null
      && stage.heartRate === null
      && stage.qualityStatus !== 'MISSING'
    ) {
      warnings.push({
        code: 'MISSING_STAGE_VALUE',
        severity: 'WARNING',
        stageNumber: stage.stageNumber,
        message: `Stufe ${stage.stageNumber ?? '?'} ist eingeschlossen, enthält aber weder Laktat- noch Herzfrequenzwert.`,
      });
    }

    if (
      stage.lactateValueX100 !== null
      && stage.lactateQualifier !== null
      && stage.lactateQualifier !== 'EXACT'
    ) {
      warnings.push({
        code: 'BOUNDARY_QUALIFIER',
        severity: 'INFO',
        stageNumber: stage.stageNumber,
        message: `Stufe ${stage.stageNumber ?? '?'} enthält einen Grenzwert-Qualifier; Trend- und Schwellenberechnungen müssen die Zensierung berücksichtigen.`,
      });
    }

    if (stage.lactateValueX100 !== null && stage.lactateQualifier === 'EXACT') {
      if (
        previousExactLactate?.lactateValueX100 !== null
        && previousExactLactate?.lactateValueX100 !== undefined
        && previousExactLactate.lactateValueX100 - stage.lactateValueX100 >= LACTATE_DROP_X100
      ) {
        warnings.push({
          code: 'LACTATE_DROP',
          severity: 'WARNING',
          stageNumber: stage.stageNumber,
          message: `Der exakte Laktatwert fällt gegenüber Stufe ${previousExactLactate.stageNumber ?? '?'} um mindestens 0,50 mmol/L.`,
        });
      }
      previousExactLactate = stage;
    }

    if (stage.heartRate !== null) {
      if (
        previousHeartRate?.heartRate !== null
        && previousHeartRate?.heartRate !== undefined
        && previousHeartRate.heartRate - stage.heartRate >= HEART_RATE_DROP_BPM
      ) {
        warnings.push({
          code: 'HEART_RATE_DROP',
          severity: 'WARNING',
          stageNumber: stage.stageNumber,
          message: `Die Herzfrequenz fällt gegenüber Stufe ${previousHeartRate.stageNumber ?? '?'} um mindestens 10 Schläge/min.`,
        });
      }
      previousHeartRate = stage;
    }
  }

  return warnings;
}
