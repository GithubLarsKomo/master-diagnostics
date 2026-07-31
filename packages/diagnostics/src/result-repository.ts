import {
  type DeepReadonly,
  type DiagnosticResultSnapshot,
  createDiagnosticResultSnapshot,
  verifyDiagnosticResultSnapshot,
} from './result-snapshot';

export interface DiagnosticResultRecord<Result = unknown> {
  readonly id: string;
  readonly recordedAt: string;
  readonly snapshot: DiagnosticResultSnapshot<Result>;
}

export interface DiagnosticResultRepository {
  append<Result>(result: Result): Promise<DiagnosticResultRecord<Result>>;
  read<Result>(id: string): Promise<DeepReadonly<Result>>;
  list(): readonly DiagnosticResultRecord[];
}

export interface DiagnosticResultRepositoryOptions {
  readonly createId: () => string;
  readonly now: () => Date;
}

function freezeRecord<Result>(record: DiagnosticResultRecord<Result>): DiagnosticResultRecord<Result> {
  return Object.freeze(record);
}

/**
 * Process-local append-only repository used as the persistence contract reference.
 * Stored records cannot be replaced or deleted and every read verifies snapshot integrity.
 */
export class InMemoryDiagnosticResultRepository implements DiagnosticResultRepository {
  readonly #records = new Map<string, DiagnosticResultRecord>();
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(options: DiagnosticResultRepositoryOptions) {
    this.#createId = options.createId;
    this.#now = options.now;
  }

  async append<Result>(result: Result): Promise<DiagnosticResultRecord<Result>> {
    const id = this.#createId();
    if (!id.trim()) {
      throw new TypeError('Diagnostic result record IDs must not be empty.');
    }
    if (this.#records.has(id)) {
      throw new Error(`Diagnostic result record already exists: ${id}.`);
    }

    const recordedAt = this.#now().toISOString();
    const snapshot = await createDiagnosticResultSnapshot(result);
    const record = freezeRecord({ id, recordedAt, snapshot });
    this.#records.set(id, record as DiagnosticResultRecord);
    return record;
  }

  async read<Result>(id: string): Promise<DeepReadonly<Result>> {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Diagnostic result record not found: ${id}.`);
    }
    return verifyDiagnosticResultSnapshot<Result>(record.snapshot);
  }

  list(): readonly DiagnosticResultRecord[] {
    return Object.freeze(Array.from(this.#records.values()));
  }
}
