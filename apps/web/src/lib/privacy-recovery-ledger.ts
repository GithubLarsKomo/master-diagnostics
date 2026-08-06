import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const PRIVACY_RECOVERY_LEDGER_VERSION = 1;
export type PrivacyRecoveryLedgerState = 'INTENT' | 'COMMITTED' | 'ABORTED';

export interface PrivacyRecoveryLedgerIdentity {
  readonly tenantId: string;
  readonly athleteId: string;
  readonly executionId: string;
  readonly approvalId: string;
}

export interface PrivacyRecoveryLedgerEntry extends PrivacyRecoveryLedgerIdentity {
  readonly ledgerVersion: 1;
  readonly state: PrivacyRecoveryLedgerState;
  readonly recordedAt: string;
}

export interface PrivacyRecoveryLedger {
  recordIntent(identity: PrivacyRecoveryLedgerIdentity, recordedAt: string): Promise<PrivacyRecoveryLedgerEntry>;
  recordCommitted(identity: PrivacyRecoveryLedgerIdentity, recordedAt: string): Promise<PrivacyRecoveryLedgerEntry>;
  recordAborted(identity: PrivacyRecoveryLedgerIdentity, recordedAt: string): Promise<PrivacyRecoveryLedgerEntry>;
}

function validateIdentity(identity: PrivacyRecoveryLedgerIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
      throw new Error(`Privacy recovery ledger ${name} is invalid`);
    }
  }
}

function validateRecordedAt(recordedAt: string): void {
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('Privacy recovery ledger timestamp is invalid');
}

function entryKey(identity: PrivacyRecoveryLedgerIdentity): string {
  return createHash('sha256')
    .update(`${identity.tenantId}\u0000${identity.athleteId}\u0000${identity.executionId}\u0000${identity.approvalId}`)
    .digest('hex');
}

function entryPath(root: string, identity: PrivacyRecoveryLedgerIdentity, state: PrivacyRecoveryLedgerState): string {
  return join(root, `${entryKey(identity)}.${state.toLowerCase()}.json`);
}

function sameIdentity(entry: PrivacyRecoveryLedgerEntry, identity: PrivacyRecoveryLedgerIdentity): boolean {
  return entry.tenantId === identity.tenantId
    && entry.athleteId === identity.athleteId
    && entry.executionId === identity.executionId
    && entry.approvalId === identity.approvalId;
}

async function readEntry(path: string): Promise<PrivacyRecoveryLedgerEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Privacy recovery ledger entry is invalid');
    }
    const entry = parsed as PrivacyRecoveryLedgerEntry;
    if (entry.ledgerVersion !== PRIVACY_RECOVERY_LEDGER_VERSION
      || !['INTENT', 'COMMITTED', 'ABORTED'].includes(entry.state)
      || !Number.isFinite(Date.parse(entry.recordedAt))) {
      throw new Error('Privacy recovery ledger entry is invalid');
    }
    validateIdentity(entry);
    return Object.freeze({ ...entry });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function createEntryExclusive(path: string, entry: PrivacyRecoveryLedgerEntry): Promise<PrivacyRecoveryLedgerEntry> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await handle.sync();
    return Object.freeze({ ...entry });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readEntry(path);
    if (!existing || existing.state !== entry.state || !sameIdentity(existing, entry)) {
      throw new Error('Privacy recovery ledger entry conflicts with existing data');
    }
    return existing;
  } finally {
    await handle?.close();
  }
}

export class FileSystemPrivacyRecoveryLedger implements PrivacyRecoveryLedger {
  constructor(private readonly root: string) {}

  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await stat(this.root);
    if (!info.isDirectory()) throw new Error('Privacy recovery ledger root is not a directory');
  }

  private async record(
    state: PrivacyRecoveryLedgerState,
    identity: PrivacyRecoveryLedgerIdentity,
    recordedAt: string,
  ): Promise<PrivacyRecoveryLedgerEntry> {
    validateIdentity(identity);
    validateRecordedAt(recordedAt);
    await this.prepare();

    const intentPath = entryPath(this.root, identity, 'INTENT');
    const committedPath = entryPath(this.root, identity, 'COMMITTED');
    const abortedPath = entryPath(this.root, identity, 'ABORTED');

    if (state !== 'INTENT') {
      const intent = await readEntry(intentPath);
      if (!intent || !sameIdentity(intent, identity)) {
        throw new Error('Privacy recovery ledger terminal state requires a matching intent');
      }
    }
    if (state === 'COMMITTED' && await readEntry(abortedPath)) {
      throw new Error('Privacy recovery ledger execution is already aborted');
    }
    if (state === 'ABORTED' && await readEntry(committedPath)) {
      throw new Error('Privacy recovery ledger execution is already committed');
    }

    return createEntryExclusive(entryPath(this.root, identity, state), Object.freeze({
      ledgerVersion: PRIVACY_RECOVERY_LEDGER_VERSION,
      state,
      ...identity,
      recordedAt,
    }));
  }

  recordIntent(identity: PrivacyRecoveryLedgerIdentity, recordedAt: string) {
    return this.record('INTENT', identity, recordedAt);
  }

  recordCommitted(identity: PrivacyRecoveryLedgerIdentity, recordedAt: string) {
    return this.record('COMMITTED', identity, recordedAt);
  }

  recordAborted(identity: PrivacyRecoveryLedgerIdentity, recordedAt: string) {
    return this.record('ABORTED', identity, recordedAt);
  }
}

export function createPrivacyRecoveryLedger(): PrivacyRecoveryLedger {
  return new FileSystemPrivacyRecoveryLedger(
    process.env.PRIVACY_RECOVERY_LEDGER_DIR ?? '/var/lib/masters/privacy-recovery-ledger',
  );
}
