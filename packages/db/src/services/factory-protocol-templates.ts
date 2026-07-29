export type FactoryProtocolDeviceType = 'BIKEERG' | 'ROWERG' | 'RP3';

export interface FactoryProtocolTemplateDefinition {
  deviceType: FactoryProtocolDeviceType;
  name: string;
}

export const FACTORY_PROTOCOL_TEMPLATES = [
  { deviceType: 'BIKEERG', name: 'BikeErg' },
  { deviceType: 'ROWERG', name: 'RowErg' },
  { deviceType: 'RP3', name: 'RP3' },
] as const satisfies readonly FactoryProtocolTemplateDefinition[];

const FACTORY_PROTOCOL_CONFIG = JSON.stringify({
  audioWarningSeconds: [30, 10, 3],
  restingMeasurement: 'BEFORE_WARMUP',
});

export function buildFactoryProtocolTemplateSeed(
  tenantId: string,
  createdByUserId: string,
  now: string,
) {
  return FACTORY_PROTOCOL_TEMPLATES.map((definition) => {
    const templateId = crypto.randomUUID();

    return {
      template: {
        id: templateId,
        tenantId,
        deviceType: definition.deviceType,
        name: definition.name,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      version: {
        id: crypto.randomUUID(),
        tenantId,
        templateId,
        versionNumber: 1,
        warmupSeconds: 600,
        readinessSeconds: 120,
        stageSeconds: 240,
        pauseSeconds: 60,
        sampleTargetSeconds: 30,
        recoverySeconds: 300,
        defaultMaxStages: 8,
        partialInclusionPercent: 50,
        configJson: FACTORY_PROTOCOL_CONFIG,
        createdByUserId,
        createdAt: now,
        updatedAt: now,
      },
    };
  });
}
