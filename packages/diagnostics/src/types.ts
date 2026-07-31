export interface DiagnosticPoint {
  watts: number;
  lactate: number;
  heartRate?: number;
  lactateQualifier?: 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';
  included: boolean;
}

export interface ThresholdEstimate {
  watts: number;
  lactate: number;
  heartRate?: number;
  algorithm: string;
  version: string;
  warnings: string[];
}
