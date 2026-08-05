import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  protocolTemplates,
  protocolTemplateVersions,
} from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export type ProtocolTemplateDeviceType = 'BIKEERG' | 'ROWERG' | 'RP3';

export const PROTOCOL_OPTIONAL_INPUT_FIELDS = [
  'ROOM_TEMPERATURE',
  'HUMIDITY',
  'ALTITUDE',
  'SLEEP_QUALITY',
  'SUBJECTIVE_RECOVERY',
  'LAST_MEAL',
  'CAFFEINE_INTAKE',
  'TRAINING_LOAD_24H',
  'TRAINING_LOAD_48H',
  'ACUTE_COMPLAINTS',
  'MEDICATION',
  'HYDRATION_STATUS',
  'LACTATE_METER',
  'TEST_STRIP_LOT',
  'NOTES',
] as const;

export type ProtocolOptionalInputField = typeof PROTOCOL_OPTIONAL_INPUT_FIELDS[number];

export type ProtocolTemplateActor = AuditActorContext;

export interface ProtocolTemplateVersionInput {
  name: string;
  deviceType: ProtocolTemplateDeviceType;
  startPowerWatts: number | null;
  incrementWatts: number | null;
  warmupSeconds: number;
  warmupPowerWatts: number | null;
  readinessSeconds: number;
  stageSeconds: number;
  pauseSeconds: number;
  sampleTargetSeconds: number;
  defaultMaxStages: number;
  abortHints: string[];
  optionalInputFields: ProtocolOptionalInputField[];
}

function requireTenantAdmin(actor: ProtocolTemplateActor): void {
  if (actor.role !== 'TENANT_ADMIN') {
    throw new Error('Only tenant admins may configure protocol templates');
  }
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
}

function normalizeOptionalPower(value: number | null, field: string): number | null {
  if (value === null) return null;
  requireIntegerInRange(value, 1, 2_000, field);
  return value;
}

function normalizeInput(input: ProtocolTemplateVersionInput): ProtocolTemplateVersionInput {
  const name = input.name.trim();
  if (!name || name.length > 100) {
    throw new Error('Protocol template name must contain between 1 and 100 characters');
  }

  requireIntegerInRange(input.warmupSeconds, 0, 3_600, 'Warm-up seconds');
  requireIntegerInRange(input.readinessSeconds, 0, 600, 'Readiness seconds');
  requireIntegerInRange(input.stageSeconds, 60, 1_800, 'Stage seconds');
  requireIntegerInRange(input.pauseSeconds, 1, 600, 'Pause seconds');
  requireIntegerInRange(input.sampleTargetSeconds, 1, input.pauseSeconds, 'Sample target seconds');
  requireIntegerInRange(input.defaultMaxStages, 1, 8, 'Maximum stages');

  const allowedOptionalFields = new Set<string>(PROTOCOL_OPTIONAL_INPUT_FIELDS);
  const optionalInputFields = [...new Set(input.optionalInputFields)];
  if (optionalInputFields.some((field) => !allowedOptionalFields.has(field))) {
    throw new Error('Unsupported optional protocol input field');
  }

  const abortHints = [...new Set(input.abortHints.map((hint) => hint.trim()).filter(Boolean))];
  if (abortHints.length > 20 || abortHints.some((hint) => hint.length > 500)) {
    throw new Error('Abort hints must contain at most 20 entries of 500 characters');
  }

  return {
    ...input,
    name,
    startPowerWatts: normalizeOptionalPower(input.startPowerWatts, 'Start power'),
    incrementWatts: normalizeOptionalPower(input.incrementWatts, 'Power increment'),
    warmupPowerWatts: normalizeOptionalPower(input.warmupPowerWatts, 'Warm-up power'),
    abortHints,
    optionalInputFields,
  };
}

export function buildProtocolTemplateVersionConfig(input: ProtocolTemplateVersionInput) {
  const normalized = normalizeInput(input);
  return {
    schemaVersion: 1,
    name: normalized.name,
    deviceType: normalized.deviceType,
    startPowerWatts: normalized.startPowerWatts,
    incrementWatts: normalized.incrementWatts,
    warmupPowerWatts: normalized.warmupPowerWatts,
    abortHints: normalized.abortHints,
    optionalInputFields: normalized.optionalInputFields,
    audioWarningSeconds: [30, 10, 3],
    restingMeasurement: 'BEFORE_WARMUP',
  } as const;
}

function buildVersionValues(
  tenantId: string,
  templateId: string,
  versionNumber: number,
  actor: ProtocolTemplateActor,
  input: ProtocolTemplateVersionInput,
  now: string,
) {
  const normalized = normalizeInput(input);
  return {
    id: crypto.randomUUID(),
    tenantId,
    templateId,
    versionNumber,
    warmupSeconds: normalized.warmupSeconds,
    readinessSeconds: normalized.readinessSeconds,
    stageSeconds: normalized.stageSeconds,
    pauseSeconds: normalized.pauseSeconds,
    sampleTargetSeconds: normalized.sampleTargetSeconds,
    recoverySeconds: 300,
    defaultMaxStages: normalized.defaultMaxStages,
    partialInclusionPercent: 50,
    configJson: JSON.stringify(buildProtocolTemplateVersionConfig(normalized)),
    createdByUserId: actor.userId,
    createdAt: now,
    updatedAt: now,
  };
}

export function listProtocolTemplates(db: Database, tenantId: string) {
  return db
    .select()
    .from(protocolTemplates)
    .where(eq(protocolTemplates.tenantId, tenantId))
    .orderBy(asc(protocolTemplates.name));
}

export function listProtocolTemplateVersions(
  db: Database,
  tenantId: string,
  templateId: string,
) {
  return db
    .select()
    .from(protocolTemplateVersions)
    .where(and(
      eq(protocolTemplateVersions.tenantId, tenantId),
      eq(protocolTemplateVersions.templateId, templateId),
    ))
    .orderBy(desc(protocolTemplateVersions.versionNumber));
}

export async function createTenantProtocolTemplate(
  db: Database,
  tenantId: string,
  actor: ProtocolTemplateActor,
  input: ProtocolTemplateVersionInput,
) {
  requireTenantAdmin(actor);
  const normalized = normalizeInput(input);
  const now = new Date().toISOString();
  const templateId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const templateValues = {
    id: templateId,
    tenantId,
    deviceType: normalized.deviceType,
    name: normalized.name,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const versionValues = buildVersionValues(
    tenantId,
    templateId,
    1,
    actor,
    normalized,
    now,
  );

  await db.transaction(async (tx) => {
    const duplicate = await tx
      .select({ id: protocolTemplates.id })
      .from(protocolTemplates)
      .where(and(
        eq(protocolTemplates.tenantId, tenantId),
        eq(protocolTemplates.deviceType, normalized.deviceType),
        eq(protocolTemplates.name, normalized.name),
      ))
      .limit(1);
    if (duplicate.length > 0) {
      throw new Error('Protocol template already exists');
    }

    await tx.insert(protocolTemplates).values(templateValues);
    await tx.insert(protocolTemplateVersions).values(versionValues);
    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'protocol_template.created',
      entityType: 'protocol_template',
      entityId: templateId,
      source: 'WEB',
      correlationId,
      after: { template: templateValues, version: versionValues },
    });
  });

  return { template: templateValues, version: versionValues };
}

export async function createProtocolTemplateVersion(
  db: Database,
  tenantId: string,
  templateId: string,
  actor: ProtocolTemplateActor,
  input: ProtocolTemplateVersionInput,
) {
  requireTenantAdmin(actor);
  const normalized = normalizeInput(input);
  const now = new Date().toISOString();
  const correlationId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const template = await tx
      .select({ id: protocolTemplates.id })
      .from(protocolTemplates)
      .where(and(
        eq(protocolTemplates.id, templateId),
        eq(protocolTemplates.tenantId, tenantId),
      ))
      .limit(1);
    if (template.length === 0) {
      throw new Error('Protocol template not found');
    }

    const latestVersions = await tx
      .select({ versionNumber: protocolTemplateVersions.versionNumber })
      .from(protocolTemplateVersions)
      .where(and(
        eq(protocolTemplateVersions.tenantId, tenantId),
        eq(protocolTemplateVersions.templateId, templateId),
      ))
      .orderBy(desc(protocolTemplateVersions.versionNumber))
      .limit(1);
    const [latestVersion] = latestVersions;
    if (!latestVersion) {
      throw new Error('Protocol template has no base version');
    }

    const versionValues = buildVersionValues(
      tenantId,
      templateId,
      latestVersion.versionNumber + 1,
      actor,
      normalized,
      now,
    );
    await tx.insert(protocolTemplateVersions).values(versionValues);
    await appendAuditEvent(tx, {
      tenantId,
      occurredAt: now,
      ...auditActorFields(actor),
      action: 'protocol_template.version_created',
      entityType: 'protocol_template_version',
      entityId: versionValues.id,
      source: 'WEB',
      correlationId,
      after: versionValues,
    });

    return versionValues;
  });
}
