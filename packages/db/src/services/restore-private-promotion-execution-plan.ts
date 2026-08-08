import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import {
  RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION,
  type RestorePrivatePromotionExecutionPreflight,
} from './restore-private-promotion-execution-preflight';

export const RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME = 'promotion-execution-plan.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-execution-plan:v1\n';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type RestorePrivatePromotionVolumeRole =
  | 'LIBSQL'
  | 'REPORTS'
  | 'TENANT_EXPORTS'
  | 'DATA_SUBJECT_DELIVERY';

export interface RestorePrivatePromotionActiveVolumeSet {
  readonly libsql: string;
  readonly reports: string;
  readonly tenantExports: string;
  readonly dataSubjectDelivery: string;
}

export interface RestorePrivatePromotionExecutionPlanVolume {
  readonly role: RestorePrivatePromotionVolumeRole;
  readonly restoreWorkspaceSubpath: 'libsql' | 'reports' | 'tenant-exports' | 'data-subject-delivery';
  readonly activeVolumeName: string;
  readonly candidateVolumeName: string;
  readonly rollbackVolumeName: string;
}

export interface RestorePrivatePromotionExecutionPlanRecord {
  readonly planVersion: typeof RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_VERSION;
  readonly phase: 'PREPARED';
  readonly backupCutoff: string;
  readonly preflightVersion: typeof RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION;
  readonly preflightExecutionFingerprint: `sha256:${string}`;
  readonly readinessEvidenceFingerprint: `sha256:${string}`;
  readonly promotionIntentSignature: `hmac-sha256:${string}`;
  readonly authorizedAt: string;
  readonly candidateSetId: string;
  readonly activeVolumeSetFingerprint: `sha256:${string}`;
  readonly switchStrategy: 'VERSIONED_EXTERNAL_NAMED_VOLUMES';
  readonly rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES';
  readonly caddyPolicy: 'PRESERVE_CURRENT';
  readonly volumes: readonly Readonly<RestorePrivatePromotionExecutionPlanVolume>[];
  readonly productionMutationAllowed: false;
  readonly promotionExecuted: false;
  readonly planFingerprint: `sha256:${string}`;
}

export interface SignedRestorePrivatePromotionExecutionPlanEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionExecutionPlanRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface EnsureRestorePrivatePromotionExecutionPlanInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly preflight: Readonly<RestorePrivatePromotionExecutionPreflight>;
  readonly activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>;
}

interface CanonicalActiveVolume {
  readonly role: RestorePrivatePromotionVolumeRole;
  readonly volumeName: string;
}

const ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({ role: 'LIBSQL' as const, key: 'libsql' as const, subpath: 'libsql' as const, suffix: 'libsql' }),
  Object.freeze({ role: 'REPORTS' as const, key: 'reports' as const, subpath: 'reports' as const, suffix: 'reports' }),
  Object.freeze({ role: 'TENANT_EXPORTS' as const, key: 'tenantExports' as const, subpath: 'tenant-exports' as const, suffix: 'tenant-exports' }),
  Object.freeze({ role: 'DATA_SUBJECT_DELIVERY' as const, key: 'dataSubjectDelivery' as const, subpath: 'data-subject-delivery' as const, suffix: 'data-subject-delivery' }),
]);

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!SHA256_FINGERPRINT.test(value)) throw new Error(`${label} must be a sha256 fingerprint`);
}

function assertHmac(value: string, label: string): asserts value is `hmac-sha256:${string}` {
  if (!HMAC_SHA256_SIGNATURE.test(value)) throw new Error(`${label} must be an HMAC-SHA256 signature`);
}

function assertDockerVolumeName(value: string, label: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${label} is not a safe Docker volume name`);
}

function verifyPreflight(preflight: Readonly<RestorePrivatePromotionExecutionPreflight>): void {
  if (
    preflight.preflightVersion !== RESTORE_PRIVATE_PROMOTION_EXECUTION_PREFLIGHT_VERSION
    || preflight.status !== 'EXECUTION_READY'
    || preflight.authorizationScope !== 'PRIVATE_RESTORE_PROMOTION'
    || preflight.evidenceRecomputed !== true
    || preflight.promotionAllowed !== true
    || preflight.authorizationPersisted !== true
    || preflight.promotionExecuted !== false
  ) {
    throw new Error('Restore promotion execution plan requires a fresh EXECUTION_READY preflight');
  }
  assertCanonicalTimestamp(preflight.backupCutoff, 'Restore promotion execution plan backupCutoff');
  assertCanonicalTimestamp(preflight.authorizedAt, 'Restore promotion execution plan authorizedAt');
  if (preflight.authorizedAt < preflight.backupCutoff) {
    throw new Error('Restore promotion authorization must not precede its backup cutoff');
  }
  assertSha256(preflight.readinessEvidenceFingerprint, 'Restore promotion readiness evidence fingerprint');
  assertSha256(preflight.healthcheckFingerprint, 'Restore promotion healthcheck fingerprint');
  assertSha256(preflight.executionFingerprint, 'Restore promotion execution fingerprint');
  assertHmac(preflight.intentSignature, 'Restore promotion intent signature');
}

function canonicalActiveVolumes(
  activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>,
): readonly Readonly<CanonicalActiveVolume>[] {
  const values = ROLE_DEFINITIONS.map(({ role, key }) => {
    const volumeName = activeVolumes[key].trim();
    assertDockerVolumeName(volumeName, `Active ${role} volume`);
    return Object.freeze({ role, volumeName });
  });
  if (new Set(values.map((item) => item.volumeName)).size !== values.length) {
    throw new Error('Restore promotion active Docker volumes must be distinct');
  }
  return Object.freeze(values);
}

function activeVolumeSetFingerprint(active: readonly Readonly<CanonicalActiveVolume>[]): `sha256:${string}` {
  return sha256(JSON.stringify(active));
}

function candidateSetId(preflight: Readonly<RestorePrivatePromotionExecutionPreflight>): string {
  return `restore-${preflight.executionFingerprint.slice('sha256:'.length, 'sha256:'.length + 20)}`;
}

function candidateVolumeName(setId: string, suffix: string): string {
  const result = `master-diagnostics-${setId}-${suffix}`;
  assertDockerVolumeName(result, 'Restore promotion candidate volume');
  return result;
}

function buildVolumes(
  activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>,
  setId: string,
): readonly Readonly<RestorePrivatePromotionExecutionPlanVolume>[] {
  const active = new Map(canonicalActiveVolumes(activeVolumes).map((item) => [item.role, item.volumeName] as const));
  const values = ROLE_DEFINITIONS.map(({ role, subpath, suffix }) => {
    const activeVolumeName = active.get(role);
    if (!activeVolumeName) throw new Error(`Restore promotion active volume is missing for ${role}`);
    const candidate = candidateVolumeName(setId, suffix);
    if (candidate === activeVolumeName) {
      throw new Error(`Restore promotion candidate volume collides with active ${role} volume`);
    }
    return Object.freeze({
      role,
      restoreWorkspaceSubpath: subpath,
      activeVolumeName,
      candidateVolumeName: candidate,
      rollbackVolumeName: activeVolumeName,
    });
  });
  if (new Set(values.map((item) => item.candidateVolumeName)).size !== values.length) {
    throw new Error('Restore promotion candidate Docker volumes must be distinct');
  }
  const allActive = new Set(values.map((item) => item.activeVolumeName));
  if (values.some((item) => allActive.has(item.candidateVolumeName))) {
    throw new Error('Restore promotion candidate Docker volume collides with the active volume set');
  }
  return Object.freeze(values);
}

function planBody(record: Omit<RestorePrivatePromotionExecutionPlanRecord, 'planFingerprint'>) {
  return {
    planVersion: record.planVersion,
    phase: record.phase,
    backupCutoff: record.backupCutoff,
    preflightVersion: record.preflightVersion,
    preflightExecutionFingerprint: record.preflightExecutionFingerprint,
    readinessEvidenceFingerprint: record.readinessEvidenceFingerprint,
    promotionIntentSignature: record.promotionIntentSignature,
    authorizedAt: record.authorizedAt,
    candidateSetId: record.candidateSetId,
    activeVolumeSetFingerprint: record.activeVolumeSetFingerprint,
    switchStrategy: record.switchStrategy,
    rollbackStrategy: record.rollbackStrategy,
    caddyPolicy: record.caddyPolicy,
    volumes: record.volumes.map((item) => ({ ...item })),
    productionMutationAllowed: record.productionMutationAllowed,
    promotionExecuted: record.promotionExecuted,
  };
}

function computePlanFingerprint(record: Omit<RestorePrivatePromotionExecutionPlanRecord, 'planFingerprint'>): `sha256:${string}` {
  return sha256(JSON.stringify(planBody(record)));
}

function validateRecord(record: Readonly<RestorePrivatePromotionExecutionPlanRecord>): void {
  if (record.planVersion !== RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_VERSION || record.phase !== 'PREPARED') {
    throw new Error('Restore promotion execution plan version or phase is invalid');
  }
  assertCanonicalTimestamp(record.backupCutoff, 'Restore promotion execution plan backupCutoff');
  assertCanonicalTimestamp(record.authorizedAt, 'Restore promotion execution plan authorizedAt');
  assertSha256(record.preflightExecutionFingerprint, 'Restore promotion execution plan preflight fingerprint');
  assertSha256(record.readinessEvidenceFingerprint, 'Restore promotion execution plan readiness fingerprint');
  assertSha256(record.activeVolumeSetFingerprint, 'Restore promotion execution plan active-volume fingerprint');
  assertSha256(record.planFingerprint, 'Restore promotion execution plan fingerprint');
  assertHmac(record.promotionIntentSignature, 'Restore promotion execution plan intent signature');
  if (!/^restore-[0-9a-f]{20}$/.test(record.candidateSetId)) {
    throw new Error('Restore promotion execution plan candidate set ID is invalid');
  }
  if (
    record.switchStrategy !== 'VERSIONED_EXTERNAL_NAMED_VOLUMES'
    || record.rollbackStrategy !== 'KEEP_PREVIOUS_ACTIVE_VOLUMES'
    || record.caddyPolicy !== 'PRESERVE_CURRENT'
    || record.productionMutationAllowed !== false
    || record.promotionExecuted !== false
  ) {
    throw new Error('Restore promotion execution plan safety policy is invalid');
  }
  if (record.volumes.length !== ROLE_DEFINITIONS.length) {
    throw new Error('Restore promotion execution plan must contain exactly four application data volumes');
  }
  for (const [index, definition] of ROLE_DEFINITIONS.entries()) {
    const volume = record.volumes[index];
    if (!volume || volume.role !== definition.role || volume.restoreWorkspaceSubpath !== definition.subpath) {
      throw new Error('Restore promotion execution plan volume order or role is invalid');
    }
    assertDockerVolumeName(volume.activeVolumeName, `Restore promotion ${definition.role} active volume`);
    assertDockerVolumeName(volume.candidateVolumeName, `Restore promotion ${definition.role} candidate volume`);
    assertDockerVolumeName(volume.rollbackVolumeName, `Restore promotion ${definition.role} rollback volume`);
    if (volume.rollbackVolumeName !== volume.activeVolumeName) {
      throw new Error('Restore promotion rollback volume must preserve the previously active volume');
    }
    if (volume.candidateVolumeName !== candidateVolumeName(record.candidateSetId, definition.suffix)) {
      throw new Error('Restore promotion candidate volume name does not match the deterministic plan');
    }
  }
  const active = record.volumes.map((item) => Object.freeze({ role: item.role, volumeName: item.activeVolumeName }));
  if (activeVolumeSetFingerprint(active) !== record.activeVolumeSetFingerprint) {
    throw new Error('Restore promotion execution plan active volume fingerprint does not match');
  }
  const fingerprint = computePlanFingerprint({ ...record, planFingerprint: undefined } as never);
  if (fingerprint !== record.planFingerprint) {
    throw new Error('Restore promotion execution plan fingerprint does not match its content');
  }
}

function assertPlanBinding(
  record: Readonly<RestorePrivatePromotionExecutionPlanRecord>,
  preflight: Readonly<RestorePrivatePromotionExecutionPreflight>,
  activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>,
): void {
  verifyPreflight(preflight);
  const active = canonicalActiveVolumes(activeVolumes);
  if (
    record.backupCutoff !== preflight.backupCutoff
    || record.preflightVersion !== preflight.preflightVersion
    || record.preflightExecutionFingerprint !== preflight.executionFingerprint
    || record.readinessEvidenceFingerprint !== preflight.readinessEvidenceFingerprint
    || record.promotionIntentSignature !== preflight.intentSignature
    || record.authorizedAt !== preflight.authorizedAt
    || record.candidateSetId !== candidateSetId(preflight)
    || record.activeVolumeSetFingerprint !== activeVolumeSetFingerprint(active)
  ) {
    throw new Error('Restore promotion execution plan does not match current preflight or active volumes');
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion execution plan key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion execution plan key must be a regular non-symlink file');
  }
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Restore promotion execution plan key must decode to exactly 32 bytes');
  return key;
}

async function ensureTargetDirectory(targetDir: string): Promise<void> {
  if (!isAbsolute(targetDir)) throw new Error('Restore promotion execution plan target directory must be absolute');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(targetDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion execution plan target must be a non-symlink directory');
  }
  await chmod(targetDir, 0o700);
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionExecutionPlanRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivatePromotionExecutionPlanRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

export function createRestorePrivatePromotionExecutionPlanRecord(
  preflight: Readonly<RestorePrivatePromotionExecutionPreflight>,
  activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>,
): Readonly<RestorePrivatePromotionExecutionPlanRecord> {
  verifyPreflight(preflight);
  const active = canonicalActiveVolumes(activeVolumes);
  const setId = candidateSetId(preflight);
  const withoutFingerprint = Object.freeze({
    planVersion: RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_VERSION,
    phase: 'PREPARED' as const,
    backupCutoff: preflight.backupCutoff,
    preflightVersion: preflight.preflightVersion,
    preflightExecutionFingerprint: preflight.executionFingerprint,
    readinessEvidenceFingerprint: preflight.readinessEvidenceFingerprint,
    promotionIntentSignature: preflight.intentSignature,
    authorizedAt: preflight.authorizedAt,
    candidateSetId: setId,
    activeVolumeSetFingerprint: activeVolumeSetFingerprint(active),
    switchStrategy: 'VERSIONED_EXTERNAL_NAMED_VOLUMES' as const,
    rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES' as const,
    caddyPolicy: 'PRESERVE_CURRENT' as const,
    volumes: buildVolumes(activeVolumes, setId),
    productionMutationAllowed: false as const,
    promotionExecuted: false as const,
  });
  const record = Object.freeze({
    ...withoutFingerprint,
    planFingerprint: computePlanFingerprint(withoutFingerprint),
  });
  validateRecord(record);
  assertPlanBinding(record, preflight, activeVolumes);
  return record;
}

export async function readVerifiedRestorePrivatePromotionExecutionPlan(
  filePath: string,
  keyFile: string,
  preflight: Readonly<RestorePrivatePromotionExecutionPreflight>,
  activeVolumes: Readonly<RestorePrivatePromotionActiveVolumeSet>,
): Promise<Readonly<SignedRestorePrivatePromotionExecutionPlanEnvelope>> {
  if (!isAbsolute(filePath)) throw new Error('Restore promotion execution plan path must be absolute');
  if (basename(filePath) !== RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME) {
    throw new Error('Restore promotion execution plan file name is invalid');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion execution plan must be a regular non-symlink file');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionExecutionPlanEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore promotion execution plan envelope version is invalid');
  }
  validateRecord(parsed.record);
  assertPlanBinding(parsed.record, preflight, activeVolumes);
  if (typeof parsed.signature !== 'string' || !HMAC_SHA256_SIGNATURE.test(parsed.signature)) {
    throw new Error('Restore promotion execution plan signature is invalid');
  }
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore promotion execution plan signature verification failed');
  }
  return Object.freeze({ envelopeVersion: parsed.envelopeVersion, record: parsed.record, signature: parsed.signature });
}

export async function persistSignedRestorePrivatePromotionExecutionPlan(
  targetDir: string,
  keyFile: string,
  record: Readonly<RestorePrivatePromotionExecutionPlanRecord>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionExecutionPlanEnvelope }>> {
  validateRecord(record);
  await ensureTargetDirectory(targetDir);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_ENVELOPE_VERSION,
    record,
    signature: signRecord(key, record),
  }) satisfies SignedRestorePrivatePromotionExecutionPlanEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(targetDir, RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME);
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME}.${crypto.randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readFile(finalPath, 'utf8').catch(() => null);
      if (existing === serialized) return Object.freeze({ path: finalPath, created: false, envelope });
      throw new Error('Restore promotion execution plan already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function ensureSignedRestorePrivatePromotionExecutionPlan(
  input: Readonly<EnsureRestorePrivatePromotionExecutionPlanInput>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionExecutionPlanEnvelope }>> {
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_PROMOTION_EXECUTION_PLAN_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivatePromotionExecutionPlan(
      finalPath,
      input.keyFile,
      input.preflight,
      input.activeVolumes,
    );
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
  const record = createRestorePrivatePromotionExecutionPlanRecord(input.preflight, input.activeVolumes);
  try {
    return await persistSignedRestorePrivatePromotionExecutionPlan(input.targetDir, input.keyFile, record);
  } catch (error) {
    const existing = await readVerifiedRestorePrivatePromotionExecutionPlan(
      finalPath,
      input.keyFile,
      input.preflight,
      input.activeVolumes,
    ).catch(() => null);
    if (existing) return Object.freeze({ path: finalPath, created: false, envelope: existing });
    throw error;
  }
}
