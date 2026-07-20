export type DeviceType = 'BIKEERG' | 'ROWERG' | 'RP3';
export type DataSource = 'MANUAL' | 'BLUETOOTH' | 'SYSTEM_DERIVED';
export type LactateQualifier = 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';
export type QualityStatus = 'VALID' | 'PARTIAL' | 'EXCLUDED' | 'MISSING' | 'MANUALLY_CORRECTED';

export interface LactateMeasurement {
  valueX100: number | null;
  qualifier: LactateQualifier;
}
