import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION,
  type RestorePrivacyArtifactReplayEntry,
  type RestorePrivacyArtifactReplayManifest,
} from './restore-privacy-artifact-replay-manifest';

export const RESTORE_PRIVACY_ARTIFACT_REPLAY_RESULT_VERSION = 1 as const;

export interface RestorePrivacyArtifactReplayRoots {
  readonly reportRoot: string;
  readonly tenantExportRoot: string;
  readonly dataSubjectDeliveryRoot: string;
}

export interface RestorePrivacyArtifactReplayResult {
  readonly resultVersion: typeof RESTORE_PRIVACY_ARTIFACT_REPLAY_RESULT_VERSION;
  readonly manifestVersion: typeof RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION;
  readonly backupCutoff: string;
  readonly reconciliationStatus: 'CLEAR' | 'REPLAY_REQUIRED';
  readonly obligationCount: number;
  readonly obligationsFingerprint: `sha256:${string}`;
  readonly entryCount: number;
  readonly entriesFingerprint: `sha256:${string}`;
  readonly verifiedAbsentCount: number;
  readonly promotionAllowed: false;
}

export interface AppliedRestorePrivacyArtifactReplay {
  readonly removedCount: number;
  readonly alreadyAbsentCount: number;
  readonly result: Readonly<RestorePrivacyArtifactReplayResult>;
}

export interface PersistedRestorePrivacyArtifactReplayResult {
  readonly created: boolean;
  readonly result: Readonly<RestorePrivacyArtifactReplayResult>;
}

const REPORT_REFERENCE = /^[a-zA-Z0-9/_-]+\.pdf$/;
const TENANT_EXPORT_REFERENCE = /^[a-f0-9-]+\.mde$/;
const DATA_SUBJECT_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mdse$/i;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

function entryKey(entry: Readonly<RestorePrivacyArtifactReplayEntry>): string {
  return [entry.kind, entry.tenantId, entry.athleteId ?? '', entry.storageReference].join('\n');
}

function assertManifestShape(manifest: Readonly<RestorePrivacyArtifactReplayManifest>): void {
  if (manifest.manifestVersion !== RESTORE_PRIVACY_ARTIFACT_REPLAY_MANIFEST_VERSION) {
    throw new Error('Restore privacy artifact replay manifest version is unsupported');
  }
  if (manifest.reconciliationStatus !== 'CLEAR' && manifest.reconciliationStatus !== 'REPLAY_REQUIRED') {
    throw new Error('Restore privacy artifact replay manifest status is unsupported');
  }
  if (!SHA256_FINGERPRINT.test(manifest.obligationsFingerprint) || !SHA256_FINGERPRINT.test(manifest.entriesFingerprint)) {
    throw new Error('Restore privacy artifact replay manifest fingerprint is invalid');
  }
  if (!Array.isArray(manifest.entries) || manifest.entryCount !== manifest.entries.length) {
    throw new Error('Restore privacy artifact replay manifest entry count is invalid');
  }
  if (manifest.reconciliationStatus === 'CLEAR' && manifest.entryCount !== 0) {
    throw new Error('CLEAR restore privacy reconciliation must have an empty artifact replay plan');
  }
  const canonicalEntries = [...manifest.entries].sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  if (JSON.stringify(canonicalEntries) !== JSON.stringify(manifest.entries)) {
    throw new Error('Restore privacy artifact replay manifest entries are not in canonical order');
  }
  if (new Set(manifest.entries.map((entry) => entryKey(entry))).size !== manifest.entries.length) {
    throw new Error('Restore privacy artifact replay manifest contains duplicate entries');
  }
  if (sha256(JSON.stringify(manifest.entries)) !== manifest.entriesFingerprint) {
    throw new Error('Restore privacy artifact replay manifest entries fingerprint does not match its entries');
  }
}

function assertSafeEntryReference(entry: Readonly<RestorePrivacyArtifactReplayEntry>): void {
  const reference = entry.storageReference;
  if (!reference || reference.startsWith('/') || reference.includes('..') || reference.includes('\\')) {
    throw new Error('Restore privacy artifact replay entry contains an unsafe storage reference');
  }
  if (entry.kind === 'REPORT') {
    if (!entry.athleteId || !REPORT_REFERENCE.test(reference) || !reference.startsWith(`${entry.tenantId}/`)) {
      throw new Error('Restore privacy report replay reference is unsafe or outside its tenant scope');
    }
    return;
  }
  if (entry.kind === 'TENANT_EXPORT') {
    if (entry.athleteId !== null || !TENANT_EXPORT_REFERENCE.test(reference)) {
      throw new Error('Restore privacy tenant export replay reference is unsafe');
    }
    return;
  }
  if (entry.kind === 'DATA_SUBJECT_DELIVERY') {
    if (!entry.athleteId || !DATA_SUBJECT_REFERENCE.test(reference)) {
      throw new Error('Restore privacy data subject replay reference is unsafe');
    }
    return;
  }
  throw new Error('Restore privacy artifact replay entry kind is unsupported');
}

async function assertRootDirectory(root: string, label: string): Promise<string> {
  if (!root.trim() || !isAbsolute(root)) throw new Error(`${label} must be an absolute path`);
  const resolved = resolve(root);
  const stat = await lstatIfPresent(resolved);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return resolved;
}

function nestedPath(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === '' || (
    fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent)
  );
}

async function verifiedRoots(roots: Readonly<RestorePrivacyArtifactReplayRoots>) {
  const reportRoot = await assertRootDirectory(roots.reportRoot, 'Restore privacy report root');
  const tenantExportRoot = await assertRootDirectory(roots.tenantExportRoot, 'Restore privacy tenant export root');
  const dataSubjectDeliveryRoot = await assertRootDirectory(
    roots.dataSubjectDeliveryRoot,
    'Restore privacy data subject delivery root',
  );
  const values = [reportRoot, tenantExportRoot, dataSubjectDeliveryRoot];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (nestedPath(values[left], values[right]) || nestedPath(values[right], values[left])) {
        throw new Error('Restore privacy artifact roots must be distinct non-overlapping directories');
      }
    }
  }
  return Object.freeze({ reportRoot, tenantExportRoot, dataSubjectDeliveryRoot });
}

function rootForEntry(
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
  entry: Readonly<RestorePrivacyArtifactReplayEntry>,
): string {
  if (entry.kind === 'REPORT') return roots.reportRoot;
  if (entry.kind === 'TENANT_EXPORT') return roots.tenantExportRoot;
  if (entry.kind === 'DATA_SUBJECT_DELIVERY') return roots.dataSubjectDeliveryRoot;
  throw new Error('Restore privacy artifact replay entry kind is unsupported');
}

async function inspectArtifactPath(
  root: string,
  entry: Readonly<RestorePrivacyArtifactReplayEntry>,
): Promise<Readonly<{ target: string; exists: boolean }>> {
  assertSafeEntryReference(entry);
  const target = resolve(root, entry.storageReference);
  const fromRoot = relative(root, target);
  if (
    fromRoot === ''
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error('Restore privacy artifact replay target escapes its private storage root');
  }

  let current = root;
  const parts = entry.storageReference.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const stat = await lstatIfPresent(current);
    if (!stat) return Object.freeze({ target, exists: false });
    if (stat.isSymbolicLink()) {
      throw new Error('Restore privacy artifact replay refuses symlink-backed storage paths');
    }
    const finalPart = index === parts.length - 1;
    if (!finalPart && !stat.isDirectory()) {
      throw new Error('Restore privacy artifact replay parent path is not a directory');
    }
    if (finalPart && !stat.isFile()) {
      throw new Error('Restore privacy artifact replay target is not a regular file');
    }
  }
  return Object.freeze({ target, exists: true });
}

export function restorePrivacyArtifactReplayResultForManifest(
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
): Readonly<RestorePrivacyArtifactReplayResult> {
  assertManifestShape(manifest);
  return Object.freeze({
    resultVersion: RESTORE_PRIVACY_ARTIFACT_REPLAY_RESULT_VERSION,
    manifestVersion: manifest.manifestVersion,
    backupCutoff: manifest.backupCutoff,
    reconciliationStatus: manifest.reconciliationStatus,
    obligationCount: manifest.obligationCount,
    obligationsFingerprint: manifest.obligationsFingerprint,
    entryCount: manifest.entryCount,
    entriesFingerprint: manifest.entriesFingerprint,
    verifiedAbsentCount: manifest.entryCount,
    promotionAllowed: false,
  });
}

export function verifyRestorePrivacyArtifactReplayResult(
  result: Readonly<RestorePrivacyArtifactReplayResult>,
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
): void {
  const expected = restorePrivacyArtifactReplayResultForManifest(manifest);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error('Restore privacy artifact replay result does not match the verified manifest');
  }
}

export async function applyRestorePrivacyArtifactReplay(
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
  roots: Readonly<RestorePrivacyArtifactReplayRoots>,
): Promise<Readonly<AppliedRestorePrivacyArtifactReplay>> {
  assertManifestShape(manifest);
  const safeRoots = await verifiedRoots(roots);
  let removedCount = 0;
  let alreadyAbsentCount = 0;

  for (const entry of manifest.entries) {
    const inspected = await inspectArtifactPath(rootForEntry(safeRoots, entry), entry);
    if (!inspected.exists) {
      alreadyAbsentCount += 1;
      continue;
    }
    try {
      await unlink(inspected.target);
      removedCount += 1;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        alreadyAbsentCount += 1;
        continue;
      }
      throw error;
    }
  }

  for (const entry of manifest.entries) {
    const inspected = await inspectArtifactPath(rootForEntry(safeRoots, entry), entry);
    if (inspected.exists) {
      throw new Error('Restore privacy artifact replay did not remove every manifest-bound artifact');
    }
  }

  return Object.freeze({
    removedCount,
    alreadyAbsentCount,
    result: restorePrivacyArtifactReplayResultForManifest(manifest),
  });
}

export async function readVerifiedRestorePrivacyArtifactReplayResultIfPresent(
  filePath: string,
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
): Promise<Readonly<RestorePrivacyArtifactReplayResult> | null> {
  let serialized: string;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  let parsed: RestorePrivacyArtifactReplayResult;
  try {
    parsed = JSON.parse(serialized) as RestorePrivacyArtifactReplayResult;
  } catch (error) {
    throw new Error('Restore privacy artifact replay result is not valid JSON', { cause: error });
  }
  verifyRestorePrivacyArtifactReplayResult(parsed, manifest);
  await chmod(filePath, 0o600);
  return Object.freeze(parsed);
}

export async function persistRestorePrivacyArtifactReplayResult(
  filePath: string,
  result: Readonly<RestorePrivacyArtifactReplayResult>,
  manifest: Readonly<RestorePrivacyArtifactReplayManifest>,
): Promise<Readonly<PersistedRestorePrivacyArtifactReplayResult>> {
  verifyRestorePrivacyArtifactReplayResult(result, manifest);
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  try {
    await writeFile(filePath, serialized, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ created: true, result });
  } catch (error) {
    const existing = await readFile(filePath, 'utf8').catch(() => null);
    if (existing === serialized) {
      await chmod(filePath, 0o600);
      return Object.freeze({ created: false, result });
    }
    if (existing !== null) {
      throw new Error('Restore privacy artifact replay result already exists with different content', { cause: error });
    }
    throw error;
  }
}
