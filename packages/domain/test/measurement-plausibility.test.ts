import { describe, expect, it } from 'vitest';
import { evaluateMeasurementPlausibility } from '../src/measurement-plausibility';

describe('measurement plausibility', () => {
  it('flags large lactate and heart-rate drops across included stages', () => {
    expect(evaluateMeasurementPlausibility([
      {
        kind: 'STAGE', stageNumber: 1, heartRate: 150,
        lactateValueX100: 220, lactateQualifier: 'EXACT', qualityStatus: 'VALID',
      },
      {
        kind: 'STAGE', stageNumber: 2, heartRate: 138,
        lactateValueX100: 160, lactateQualifier: 'EXACT', qualityStatus: 'VALID',
      },
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LACTATE_DROP', stageNumber: 2 }),
      expect.objectContaining({ code: 'HEART_RATE_DROP', stageNumber: 2 }),
    ]));
  });

  it('does not compare excluded stages and treats boundary qualifiers as informational', () => {
    const warnings = evaluateMeasurementPlausibility([
      {
        kind: 'STAGE', stageNumber: 1, heartRate: 160,
        lactateValueX100: 300, lactateQualifier: 'EXACT', qualityStatus: 'EXCLUDED',
      },
      {
        kind: 'STAGE', stageNumber: 2, heartRate: 145,
        lactateValueX100: 250, lactateQualifier: 'LESS_THAN', qualityStatus: 'VALID',
      },
    ]);

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'BOUNDARY_QUALIFIER', severity: 'INFO', stageNumber: 2,
      }),
    ]);
  });

  it('flags an included stage without any measured value', () => {
    expect(evaluateMeasurementPlausibility([
      {
        kind: 'STAGE', stageNumber: 3, heartRate: null,
        lactateValueX100: null, lactateQualifier: null, qualityStatus: 'PARTIAL',
      },
    ])).toEqual([
      expect.objectContaining({ code: 'MISSING_STAGE_VALUE', stageNumber: 3 }),
    ]);
  });

  it('keeps ordinary increasing sequences warning-free', () => {
    expect(evaluateMeasurementPlausibility([
      {
        kind: 'STAGE', stageNumber: 2, heartRate: 150,
        lactateValueX100: 180, lactateQualifier: 'EXACT', qualityStatus: 'VALID',
      },
      {
        kind: 'STAGE', stageNumber: 1, heartRate: 140,
        lactateValueX100: 120, lactateQualifier: 'EXACT', qualityStatus: 'VALID',
      },
    ])).toEqual([]);
  });
});
