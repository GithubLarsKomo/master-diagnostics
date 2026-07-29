import { buildProtocolTemplateVersionConfig } from './protocol-templates';

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

export function buildFactoryProtocolTemplateSeed(
  tenantId: string,
  createdByUserId: string,
  now: string,
) {
  return FACTORY_PROTOCOL_TEMPLATES.map((definition) => {
    const templateId = crypto.randomUUID();
    const configJson = JSON.stringify(buildProtocolTemplateVersionConfig({
      name: definition.name,
      deviceType: definition.deviceType,
      startPowerWatts: null,
      incrementWatts: null,
      warmupSeconds: 600,
      warmupPowerWatts: null,
      readinessSeconds: 120,
      stageSeconds: 240,
      pauseSeconds: 60,
      sampleTargetSeconds: 30,
      defaultMaxStages: 8,
      abortHints: [],
      optionalInputFields: [],
    }));

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
        configJson,
        createdByUserId,
        createdAt: now,
        updatedAt: now,
      },
    };
  });
}
