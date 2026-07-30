import type { QualityStatus } from './types';

export type ReviewPlausibilityWarningCode =
  | 'LACTATE_DECREASE'
  | 'IDENTICAL_LACTATE_SERIES'
  | 'INTERNAL_MISSING_LACTATE'
  | 'HEART_RATE_DECREASE'
  | 'REST_ABOVE_FIRST_STAGE'
  | 'SHORTENED_STAGE'
  | 'QUALIFIED_LACTATE'
  | 'LIMITED_EXACT_DATA_BASIS';

export interface ReviewPlausibilityWarning {
  code: ReviewPlausibilityWarningCode;
  severity: 'WARNING';
  stageNumbers: number[];
  message: string;
}

export interface ReviewPlausibilityStage {
  stageNumber: number;
  targetWatts: number;
  plannedSeconds: number;
  actualSeconds: number | null;
  heartRate: number | null;
  lactateValueX100: number | null;
  lactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  qualityStatus: QualityStatus;
}

export interface ReviewPlausibilityInput {
  restLactateValueX100: number | null;
  restLactateQualifier: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN' | null;
  stages: readonly ReviewPlausibilityStage[];
}

function lactateText(valueX100: number): string {
  return (valueX100 / 100).toFixed(2).replace('.', ',');
}

function included(stage: ReviewPlausibilityStage): boolean {
  return stage.qualityStatus !== 'EXCLUDED';
}

function exactLactateStages(
  stages: readonly ReviewPlausibilityStage[],
): ReviewPlausibilityStage[] {
  return stages.filter((stage) => (
    included(stage)
    && stage.lactateValueX100 !== null
    && stage.lactateQualifier === 'EXACT'
  ));
}

export function evaluateReviewPlausibility(
  input: ReviewPlausibilityInput,
): ReviewPlausibilityWarning[] {
  const stages = [...input.stages]
    .sort((left, right) => left.stageNumber - right.stageNumber);
  const exactStages = exactLactateStages(stages);
  const warnings: ReviewPlausibilityWarning[] = [];

  for (let index = 1; index < exactStages.length; index += 1) {
    const previous = exactStages[index - 1]!;
    const current = exactStages[index]!;
    if (current.targetWatts <= previous.targetWatts) continue;
    if (current.lactateValueX100! < previous.lactateValueX100!) {
      warnings.push({
        code: 'LACTATE_DECREASE',
        severity: 'WARNING',
        stageNumbers: [previous.stageNumber, current.stageNumber],
        message: `Laktat fällt trotz höherer Leistung von ${lactateText(previous.lactateValueX100!)} auf ${lactateText(current.lactateValueX100!)} mmol/L.`,
      });
    }
  }

  let identicalStart = 0;
  while (identicalStart < exactStages.length - 1) {
    let identicalEnd = identicalStart;
    while (
      identicalEnd + 1 < exactStages.length
      && exactStages[identicalEnd + 1]!.stageNumber
        === exactStages[identicalEnd]!.stageNumber + 1
      && exactStages[identicalEnd + 1]!.lactateValueX100
        === exactStages[identicalStart]!.lactateValueX100
    ) {
      identicalEnd += 1;
    }
    if (identicalEnd > identicalStart) {
      const run = exactStages.slice(identicalStart, identicalEnd + 1);
      warnings.push({
        code: 'IDENTICAL_LACTATE_SERIES',
        severity: 'WARNING',
        stageNumbers: run.map((stage) => stage.stageNumber),
        message: `Identischer Laktatwert von ${lactateText(run[0]!.lactateValueX100!)} mmol/L über mehrere aufeinanderfolgende Stufen.`,
      });
    }
    identicalStart = identicalEnd + 1;
  }

  const stagesWithLactate = stages.filter((stage) => (
    included(stage) && stage.lactateValueX100 !== null
  ));
  if (stagesWithLactate.length >= 2) {
    const first = stagesWithLactate[0]!.stageNumber;
    const last = stagesWithLactate[stagesWithLactate.length - 1]!.stageNumber;
    const missing = stages.filter((stage) => (
      stage.stageNumber > first
      && stage.stageNumber < last
      && included(stage)
      && stage.lactateValueX100 === null
    ));
    if (missing.length > 0) {
      warnings.push({
        code: 'INTERNAL_MISSING_LACTATE',
        severity: 'WARNING',
        stageNumbers: missing.map((stage) => stage.stageNumber),
        message: `Laktatwert innerhalb der Belastungsreihe fehlt in Stufe ${missing.map((stage) => stage.stageNumber).join(', ')}.`,
      });
    }
  }

  const heartRateStages = stages.filter((stage) => (
    included(stage) && stage.heartRate !== null
  ));
  for (let index = 1; index < heartRateStages.length; index += 1) {
    const previous = heartRateStages[index - 1]!;
    const current = heartRateStages[index]!;
    if (
      current.targetWatts > previous.targetWatts
      && current.heartRate! < previous.heartRate!
    ) {
      warnings.push({
        code: 'HEART_RATE_DECREASE',
        severity: 'WARNING',
        stageNumbers: [previous.stageNumber, current.stageNumber],
        message: `Herzfrequenz fällt trotz höherer Leistung von ${previous.heartRate} auf ${current.heartRate} 1/min.`,
      });
    }
  }

  if (
    input.restLactateValueX100 !== null
    && input.restLactateQualifier === 'EXACT'
    && exactStages.length > 0
    && input.restLactateValueX100 > exactStages[0]!.lactateValueX100!
  ) {
    warnings.push({
      code: 'REST_ABOVE_FIRST_STAGE',
      severity: 'WARNING',
      stageNumbers: [exactStages[0]!.stageNumber],
      message: `Ruhelaktat ${lactateText(input.restLactateValueX100)} mmol/L liegt über dem ersten exakten Belastungswert ${lactateText(exactStages[0]!.lactateValueX100!)} mmol/L.`,
    });
  }

  for (const stage of stages) {
    if (
      stage.actualSeconds !== null
      && stage.actualSeconds < stage.plannedSeconds
    ) {
      warnings.push({
        code: 'SHORTENED_STAGE',
        severity: 'WARNING',
        stageNumbers: [stage.stageNumber],
        message: `Stufe ${stage.stageNumber} wurde nach ${stage.actualSeconds} von ${stage.plannedSeconds} Sekunden beendet.`,
      });
    }
    if (
      included(stage)
      && stage.lactateValueX100 !== null
      && stage.lactateQualifier !== null
      && stage.lactateQualifier !== 'EXACT'
    ) {
      warnings.push({
        code: 'QUALIFIED_LACTATE',
        severity: 'WARNING',
        stageNumbers: [stage.stageNumber],
        message: `Stufe ${stage.stageNumber} enthält einen qualifizierten Laktatwert und ist nicht automatisch numerisch interpretierbar.`,
      });
    }
  }
  if (
    input.restLactateValueX100 !== null
    && input.restLactateQualifier !== null
    && input.restLactateQualifier !== 'EXACT'
  ) {
    warnings.push({
      code: 'QUALIFIED_LACTATE',
      severity: 'WARNING',
      stageNumbers: [],
      message: 'Der Ruhewert ist qualifiziert und nicht automatisch numerisch interpretierbar.',
    });
  }

  const usableExactStages = exactStages.filter((stage) => (
    stage.qualityStatus === 'VALID'
    || stage.qualityStatus === 'PARTIAL'
    || stage.qualityStatus === 'MANUALLY_CORRECTED'
  ));
  if (usableExactStages.length < 4) {
    warnings.push({
      code: 'LIMITED_EXACT_DATA_BASIS',
      severity: 'WARNING',
      stageNumbers: usableExactStages.map((stage) => stage.stageNumber),
      message: `Eingeschränkte Datenbasis: ${usableExactStages.length} von mindestens 4 verwendbaren exakten Belastungswerten vorhanden.`,
    });
  }

  return warnings;
}
