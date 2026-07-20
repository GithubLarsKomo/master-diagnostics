export interface DiagnosticPoint {
  watts: number;
  lactate: number;
  heartRate?: number;
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
