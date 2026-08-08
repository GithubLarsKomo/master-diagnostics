import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

export const RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_VERSION = 1 as const;
export const SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION = 1 as const;
export const RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME = 'promotion-switch-intent.json' as const;

const SIGNATURE_PREFIX = 'hmac-sha256:';
const SIGNING_DOMAIN = 'masters:restore-private-promotion-switch-intent:v1\n';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type RestorePrivatePromotionSwitchRole =
  | 'LIBSQL'
  | 'REPORTS'
  | 'TENANT_EXPORTS'
  | 'DATA_SUBJECT_DELIVERY';

export interface RestorePrivatePromotionCandidateHealthcheckEntry {
  readonly role: RestorePrivatePromotionSwitchRole;
  readonly sourceSubpath: 'libsql' | 'reports' | 'tenant-exports' | 'data-subject-delivery';
  readonly candidateVolumeName: string;
  readonly rollbackVolumeName: string;
  readonly sourceFingerprint: `sha256:${string}`;
  readonly candidateFingerprint: `sha256:${string}`;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly byteCount: number;
}

export interface RestorePrivatePromotionCandidateSetHealthcheck {
  readonly mode: 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK';
  readonly status: 'CANDIDATE_SET_HEALTHY';
  readonly healthcheckVersion: 1;
  readonly evidenceRecomputed: true;
  readonly candidateMutationAllowed: false;
  readonly productionMutationAllowed: false;
  readonly promotionExecuted: false;
  readonly planFingerprint: `sha256:${string}`;
  readonly activeVolumeSetFingerprint: `sha256:${string}`;
  readonly candidateSetId: string;
  readonly candidateSetFingerprint: `sha256:${string}`;
  readonly candidates: readonly Readonly<RestorePrivatePromotionCandidateHealthcheckEntry>[];
}

export interface RestorePrivatePromotionSwitchIntentVolume {
  readonly role: RestorePrivatePromotionSwitchRole;
  readonly candidateVolumeName: string;
  readonly rollbackVolumeName: string;
  readonly treeFingerprint: `sha256:${string}`;
}

export interface RestorePrivatePromotionSwitchIntentRecord {
  readonly switchIntentVersion: typeof RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_VERSION;
  readonly phase: 'PENDING';
  readonly authorizedAt: string;
  readonly candidateHealthcheckVersion: 1;
  readonly candidateSetFingerprint: `sha256:${string}`;
  readonly planFingerprint: `sha256:${string}`;
  readonly activeVolumeSetFingerprint: `sha256:${string}`;
  readonly candidateSetId: string;
  readonly selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1';
  readonly rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES';
  readonly caddyPolicy: 'PRESERVE_CURRENT';
  readonly crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION';
  readonly rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER';
  readonly completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK';
  readonly preSwitchHealthcheckRequired: true;
  readonly rollbackVolumesMustRemain: true;
  readonly productionSwitchAuthorized: true;
  readonly promotionExecuted: false;
  readonly volumes: readonly Readonly<RestorePrivatePromotionSwitchIntentVolume>[];
}

export interface SignedRestorePrivatePromotionSwitchIntentEnvelope {
  readonly envelopeVersion: typeof SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION;
  readonly record: Readonly<RestorePrivatePromotionSwitchIntentRecord>;
  readonly signature: `hmac-sha256:${string}`;
}

export interface EnsureRestorePrivatePromotionSwitchIntentInput {
  readonly targetDir: string;
  readonly keyFile: string;
  readonly healthcheck: Readonly<RestorePrivatePromotionCandidateSetHealthcheck>;
  readonly authorizedAt: string;
}

const ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({ role: 'LIBSQL' as const, subpath: 'libsql' as const }),
  Object.freeze({ role: 'REPORTS' as const, subpath: 'reports' as const }),
  Object.freeze({ role: 'TENANT_EXPORTS' as const, subpath: 'tenant-exports' as const }),
  Object.freeze({ role: 'DATA_SUBJECT_DELIVERY' as const, subpath: 'data-subject-delivery' as const }),
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Unsupported canonical JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!SHA256_FINGERPRINT.test(value)) throw new Error(`${label} must be a sha256 fingerprint`);
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!CANONICAL_UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}

function assertDockerVolumeName(value: string, label: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error(`${label} is not a safe Docker volume name`);
}

function candidateHealthcheckBody(healthcheck: Readonly<RestorePrivatePromotionCandidateSetHealthcheck>) {
  return {
    healthcheckVersion: healthcheck.healthcheckVersion,
    planFingerprint: healthcheck.planFingerprint,
    activeVolumeSetFingerprint: healthcheck.activeVolumeSetFingerprint,
    candidateSetId: healthcheck.candidateSetId,
    candidates: healthcheck.candidates.map((item) => ({ ...item })),
  };
}

export function verifyRestorePrivatePromotionCandidateSetHealthcheck(
  healthcheck: Readonly<RestorePrivatePromotionCandidateSetHealthcheck>,
): void {
  if (
    healthcheck.mode !== 'ISOLATED_RESTORE_PROMOTION_CANDIDATE_SET_HEALTHCHECK'
    || healthcheck.status !== 'CANDIDATE_SET_HEALTHY'
    || healthcheck.healthcheckVersion !== 1
    || healthcheck.evidenceRecomputed !== true
    || healthcheck.candidateMutationAllowed !== false
    || healthcheck.productionMutationAllowed !== false
    || healthcheck.promotionExecuted !== false
  ) {
    throw new Error('Restore promotion switch intent requires a fresh healthy candidate-set report');
  }
  assertSha256(healthcheck.planFingerprint, 'Candidate-set plan fingerprint');
  assertSha256(healthcheck.activeVolumeSetFingerprint, 'Candidate-set active-volume fingerprint');
  assertSha256(healthcheck.candidateSetFingerprint, 'Candidate-set fingerprint');
  if (!/^restore-[0-9a-f]{20}$/.test(healthcheck.candidateSetId)) {
    throw new Error('Candidate-set ID is invalid');
  }
  if (healthcheck.candidates.length !== ROLE_DEFINITIONS.length) {
    throw new Error('Candidate-set healthcheck must contain exactly four volume roles');
  }

  const candidateNames = new Set<string>();
  const rollbackNames = new Set<string>();
  for (const [index, definition] of ROLE_DEFINITIONS.entries()) {
    const item = healthcheck.candidates[index];
    if (!item || item.role !== definition.role || item.sourceSubpath !== definition.subpath) {
      throw new Error('Candidate-set healthcheck role order is invalid');
    }
    assertDockerVolumeName(item.candidateVolumeName, `Candidate ${item.role} volume`);
    assertDockerVolumeName(item.rollbackVolumeName, `Rollback ${item.role} volume`);
    if (item.candidateVolumeName === item.rollbackVolumeName) {
      throw new Error('Candidate and rollback volume must be different');
    }
    assertSha256(item.sourceFingerprint, `Candidate ${item.role} source fingerprint`);
    assertSha256(item.candidateFingerprint, `Candidate ${item.role} tree fingerprint`);
    if (item.sourceFingerprint !== item.candidateFingerprint) {
      throw new Error(`Candidate ${item.role} tree fingerprint does not match its source`);
    }
    for (const [value, label] of [
      [item.fileCount, 'fileCount'],
      [item.directoryCount, 'directoryCount'],
      [item.byteCount, 'byteCount'],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Candidate ${item.role} ${label} is invalid`);
      }
    }
    candidateNames.add(item.candidateVolumeName);
    rollbackNames.add(item.rollbackVolumeName);
  }
  if (candidateNames.size !== 4 || rollbackNames.size !== 4) {
    throw new Error('Candidate and rollback volume sets must each contain four distinct volumes');
  }
  if ([...candidateNames].some((name) => rollbackNames.has(name))) {
    throw new Error('Candidate and rollback volume sets must be disjoint');
  }

  const expected = sha256(canonicalJson(candidateHealthcheckBody(healthcheck)));
  if (expected !== healthcheck.candidateSetFingerprint) {
    throw new Error('Candidate-set fingerprint does not match the healthcheck content');
  }
}

function validateRecord(record: Readonly<RestorePrivatePromotionSwitchIntentRecord>): void {
  if (record.switchIntentVersion !== RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_VERSION || record.phase !== 'PENDING') {
    throw new Error('Restore promotion switch intent version or phase is invalid');
  }
  assertCanonicalTimestamp(record.authorizedAt, 'Restore promotion switch intent authorizedAt');
  assertSha256(record.candidateSetFingerprint, 'Restore promotion switch candidate-set fingerprint');
  assertSha256(record.planFingerprint, 'Restore promotion switch plan fingerprint');
  assertSha256(record.activeVolumeSetFingerprint, 'Restore promotion switch active-volume fingerprint');
  if (!/^restore-[0-9a-f]{20}$/.test(record.candidateSetId)) {
    throw new Error('Restore promotion switch candidate-set ID is invalid');
  }
  if (
    record.candidateHealthcheckVersion !== 1
    || record.selectorStrategy !== 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1'
    || record.rollbackStrategy !== 'KEEP_PREVIOUS_ACTIVE_VOLUMES'
    || record.caddyPolicy !== 'PRESERVE_CURRENT'
    || record.crashRecoveryPolicy !== 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION'
    || record.rollbackPolicy !== 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER'
    || record.completionPolicy !== 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK'
    || record.preSwitchHealthcheckRequired !== true
    || record.rollbackVolumesMustRemain !== true
    || record.productionSwitchAuthorized !== true
    || record.promotionExecuted !== false
  ) {
    throw new Error('Restore promotion switch intent safety policy is invalid');
  }
  if (record.volumes.length !== ROLE_DEFINITIONS.length) {
    throw new Error('Restore promotion switch intent must contain exactly four volume roles');
  }
  const candidates = new Set<string>();
  const rollbacks = new Set<string>();
  for (const [index, definition] of ROLE_DEFINITIONS.entries()) {
    const item = record.volumes[index];
    if (!item || item.role !== definition.role) throw new Error('Restore promotion switch volume order is invalid');
    assertDockerVolumeName(item.candidateVolumeName, `Switch candidate ${item.role} volume`);
    assertDockerVolumeName(item.rollbackVolumeName, `Switch rollback ${item.role} volume`);
    assertSha256(item.treeFingerprint, `Switch ${item.role} tree fingerprint`);
    if (item.candidateVolumeName === item.rollbackVolumeName) {
      throw new Error('Restore promotion switch candidate and rollback volume must differ');
    }
    candidates.add(item.candidateVolumeName);
    rollbacks.add(item.rollbackVolumeName);
  }
  if (candidates.size !== 4 || rollbacks.size !== 4 || [...candidates].some((name) => rollbacks.has(name))) {
    throw new Error('Restore promotion switch volume sets are invalid');
  }
}

function assertHealthcheckBinding(
  record: Readonly<RestorePrivatePromotionSwitchIntentRecord>,
  healthcheck: Readonly<RestorePrivatePromotionCandidateSetHealthcheck>,
): void {
  verifyRestorePrivatePromotionCandidateSetHealthcheck(healthcheck);
  if (
    record.candidateHealthcheckVersion !== healthcheck.healthcheckVersion
    || record.candidateSetFingerprint !== healthcheck.candidateSetFingerprint
    || record.planFingerprint !== healthcheck.planFingerprint
    || record.activeVolumeSetFingerprint !== healthcheck.activeVolumeSetFingerprint
    || record.candidateSetId !== healthcheck.candidateSetId
  ) {
    throw new Error('Restore promotion switch intent does not match candidate-set healthcheck evidence');
  }
  for (const [index, source] of healthcheck.candidates.entries()) {
    const bound = record.volumes[index];
    if (
      !bound
      || bound.role !== source.role
      || bound.candidateVolumeName !== source.candidateVolumeName
      || bound.rollbackVolumeName !== source.rollbackVolumeName
      || bound.treeFingerprint !== source.candidateFingerprint
    ) {
      throw new Error('Restore promotion switch volume binding does not match candidate-set healthcheck');
    }
  }
}

async function readSigningKey(keyFile: string): Promise<Buffer> {
  if (!isAbsolute(keyFile)) throw new Error('Restore promotion switch intent key path must be absolute');
  const stat = await lstat(keyFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch intent key must be a regular non-symlink file');
  }
  const encoded = (await readFile(keyFile, 'utf8')).trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Restore promotion switch intent key must decode to exactly 32 bytes');
  return key;
}

async function ensureTargetDirectory(targetDir: string): Promise<void> {
  if (!isAbsolute(targetDir)) throw new Error('Restore promotion switch intent target directory must be absolute');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(targetDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch intent target must be a non-symlink directory');
  }
  await chmod(targetDir, 0o700);
}

function canonicalPayload(record: Readonly<RestorePrivatePromotionSwitchIntentRecord>): string {
  return `${SIGNING_DOMAIN}${JSON.stringify({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION,
    record,
  })}`;
}

function signRecord(key: Buffer, record: Readonly<RestorePrivatePromotionSwitchIntentRecord>): `hmac-sha256:${string}` {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', key).update(canonicalPayload(record)).digest('hex')}`;
}

export function createRestorePrivatePromotionSwitchIntentRecord(
  healthcheck: Readonly<RestorePrivatePromotionCandidateSetHealthcheck>,
  authorizedAt: string,
): Readonly<RestorePrivatePromotionSwitchIntentRecord> {
  verifyRestorePrivatePromotionCandidateSetHealthcheck(healthcheck);
  const record = Object.freeze({
    switchIntentVersion: RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_VERSION,
    phase: 'PENDING' as const,
    authorizedAt,
    candidateHealthcheckVersion: healthcheck.healthcheckVersion,
    candidateSetFingerprint: healthcheck.candidateSetFingerprint,
    planFingerprint: healthcheck.planFingerprint,
    activeVolumeSetFingerprint: healthcheck.activeVolumeSetFingerprint,
    candidateSetId: healthcheck.candidateSetId,
    selectorStrategy: 'COMPOSE_EXTERNAL_NAMED_VOLUMES_V1' as const,
    rollbackStrategy: 'KEEP_PREVIOUS_ACTIVE_VOLUMES' as const,
    caddyPolicy: 'PRESERVE_CURRENT' as const,
    crashRecoveryPolicy: 'DURABLE_SWITCH_JOURNAL_BEFORE_PRODUCTION_MUTATION' as const,
    rollbackPolicy: 'RESELECT_BOUND_ROLLBACK_VOLUMES_ON_FAILED_CUTOVER' as const,
    completionPolicy: 'SIGNED_SWITCH_RECEIPT_AFTER_POST_SWITCH_HEALTHCHECK' as const,
    preSwitchHealthcheckRequired: true as const,
    rollbackVolumesMustRemain: true as const,
    productionSwitchAuthorized: true as const,
    promotionExecuted: false as const,
    volumes: Object.freeze(healthcheck.candidates.map((item) => Object.freeze({
      role: item.role,
      candidateVolumeName: item.candidateVolumeName,
      rollbackVolumeName: item.rollbackVolumeName,
      treeFingerprint: item.candidateFingerprint,
    }))),
  });
  validateRecord(record);
  assertHealthcheckBinding(record, healthcheck);
  return record;
}

export async function readVerifiedRestorePrivatePromotionSwitchIntent(
  filePath: string,
  keyFile: string,
  healthcheck: Readonly<RestorePrivatePromotionCandidateSetHealthcheck>,
): Promise<Readonly<SignedRestorePrivatePromotionSwitchIntentEnvelope>> {
  if (!isAbsolute(filePath)) throw new Error('Restore promotion switch intent path must be absolute');
  if (basename(filePath) !== RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME) {
    throw new Error('Restore promotion switch intent file name is invalid');
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Restore promotion switch intent must be a regular non-symlink file');
  }
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SignedRestorePrivatePromotionSwitchIntentEnvelope>;
  if (parsed.envelopeVersion !== SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION || !parsed.record) {
    throw new Error('Restore promotion switch intent envelope version is invalid');
  }
  validateRecord(parsed.record);
  assertHealthcheckBinding(parsed.record, healthcheck);
  if (typeof parsed.signature !== 'string' || !HMAC_SHA256_SIGNATURE.test(parsed.signature)) {
    throw new Error('Restore promotion switch intent signature is invalid');
  }
  const key = await readSigningKey(keyFile);
  const expected = signRecord(key, parsed.record);
  const actualBytes = Buffer.from(parsed.signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expectedBytes = Buffer.from(expected.slice(SIGNATURE_PREFIX.length), 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Restore promotion switch intent signature verification failed');
  }
  return Object.freeze({ envelopeVersion: parsed.envelopeVersion, record: parsed.record, signature: parsed.signature });
}

export async function persistSignedRestorePrivatePromotionSwitchIntent(
  targetDir: string,
  keyFile: string,
  record: Readonly<RestorePrivatePromotionSwitchIntentRecord>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSwitchIntentEnvelope }>> {
  validateRecord(record);
  await ensureTargetDirectory(targetDir);
  const key = await readSigningKey(keyFile);
  const envelope = Object.freeze({
    envelopeVersion: SIGNED_RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_ENVELOPE_VERSION,
    record,
    signature: signRecord(key, record),
  }) satisfies SignedRestorePrivatePromotionSwitchIntentEnvelope;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const finalPath = join(targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME);
  const tempPath = join(targetDir, `.${RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME}.${randomUUID()}.tmp`);
  await writeFile(tempPath, serialized, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tempPath, finalPath);
      return Object.freeze({ path: finalPath, created: true, envelope });
    } catch (error) {
      const existing = await readFile(finalPath, 'utf8').catch(() => null);
      if (existing === serialized) return Object.freeze({ path: finalPath, created: false, envelope });
      throw new Error('Restore promotion switch intent already exists with different content', { cause: error });
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function ensureSignedRestorePrivatePromotionSwitchIntent(
  input: Readonly<EnsureRestorePrivatePromotionSwitchIntentInput>,
): Promise<Readonly<{ path: string; created: boolean; envelope: SignedRestorePrivatePromotionSwitchIntentEnvelope }>> {
  const finalPath = join(input.targetDir, RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE_NAME);
  try {
    const existing = await readVerifiedRestorePrivatePromotionSwitchIntent(
      finalPath,
      input.keyFile,
      input.healthcheck,
    );
    return Object.freeze({ path: finalPath, created: false, envelope: existing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
  const record = createRestorePrivatePromotionSwitchIntentRecord(input.healthcheck, input.authorizedAt);
  try {
    return await persistSignedRestorePrivatePromotionSwitchIntent(input.targetDir, input.keyFile, record);
  } catch (error) {
    const existing = await readVerifiedRestorePrivatePromotionSwitchIntent(
      finalPath,
      input.keyFile,
      input.healthcheck,
    ).catch(() => null);
    if (existing) return Object.freeze({ path: finalPath, created: false, envelope: existing });
    throw error;
  }
}
