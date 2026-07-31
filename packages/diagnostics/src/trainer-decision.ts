export type DiagnosticMethod =
  | 'FIXED_2_4'
  | 'BASELINE_PLUS_ONE'
  | 'DMAX'
  | 'MODIFIED_DMAX';

export interface DiagnosticDecisionCandidate {
  readonly method: DiagnosticMethod;
  readonly available: boolean;
  readonly resultHash?: string;
  readonly warnings?: readonly string[];
}

export interface CreateTrainerDiagnosticDecisionInput {
  readonly selectedMethod: DiagnosticMethod;
  readonly candidates: readonly DiagnosticDecisionCandidate[];
  readonly rationale: string;
  readonly warningAcknowledgement?: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface TrainerDiagnosticDecisionAlternative {
  readonly method: DiagnosticMethod;
  readonly available: boolean;
  readonly resultHash?: string;
  readonly warnings: readonly string[];
}

export interface TrainerDiagnosticDecision {
  readonly schemaVersion: 'trainer-diagnostic-decision-v1';
  readonly selectedMethod: DiagnosticMethod;
  readonly selectedResultHash: string;
  readonly rationale: string;
  readonly warningAcknowledgement?: string;
  readonly alternatives: readonly TrainerDiagnosticDecisionAlternative[];
  readonly decidedBy: string;
  readonly decidedAt: string;
}

const RESULT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function normalizeWarnings(warnings: readonly string[] | undefined): readonly string[] {
  const normalized = [...new Set((warnings ?? []).map((warning) => warning.trim()).filter(Boolean))];
  return Object.freeze(normalized);
}

function requireResultHash(value: string | undefined, method: DiagnosticMethod): string {
  if (!value || !RESULT_HASH_PATTERN.test(value)) {
    throw new TypeError(`Available candidate ${method} requires a valid SHA-256 result hash`);
  }
  return value;
}

function freezeAlternative(
  candidate: DiagnosticDecisionCandidate,
): TrainerDiagnosticDecisionAlternative {
  return Object.freeze({
    method: candidate.method,
    available: candidate.available,
    ...(candidate.resultHash ? { resultHash: candidate.resultHash } : {}),
    warnings: normalizeWarnings(candidate.warnings),
  });
}

/**
 * Records an explicit human method choice without silently replacing it with an
 * automated clinical recommendation.
 */
export function createTrainerDiagnosticDecision(
  input: CreateTrainerDiagnosticDecisionInput,
): TrainerDiagnosticDecision {
  if (input.candidates.length === 0) {
    throw new TypeError('At least one diagnostic candidate is required');
  }

  const methods = new Set<DiagnosticMethod>();
  for (const candidate of input.candidates) {
    if (methods.has(candidate.method)) {
      throw new TypeError(`Duplicate diagnostic candidate: ${candidate.method}`);
    }
    methods.add(candidate.method);
    if (candidate.available) requireResultHash(candidate.resultHash, candidate.method);
  }

  const selected = input.candidates.find(
    (candidate) => candidate.method === input.selectedMethod,
  );
  if (!selected) {
    throw new TypeError('Selected diagnostic method is not part of the candidate set');
  }
  if (!selected.available) {
    throw new TypeError('Selected diagnostic method is not available');
  }

  const selectedWarnings = normalizeWarnings(selected.warnings);
  const warningAcknowledgement = input.warningAcknowledgement?.trim();
  if (selectedWarnings.length > 0 && !warningAcknowledgement) {
    throw new TypeError('Selected diagnostic warnings require an acknowledgement');
  }

  const decidedAt = requireText(input.decidedAt, 'Decision timestamp');
  if (Number.isNaN(Date.parse(decidedAt))) {
    throw new TypeError('Decision timestamp must be a valid ISO-8601 date-time');
  }

  const alternatives = input.candidates
    .filter((candidate) => candidate.method !== input.selectedMethod)
    .map(freezeAlternative);

  return Object.freeze({
    schemaVersion: 'trainer-diagnostic-decision-v1',
    selectedMethod: input.selectedMethod,
    selectedResultHash: requireResultHash(selected.resultHash, selected.method),
    rationale: requireText(input.rationale, 'Decision rationale'),
    ...(warningAcknowledgement
      ? { warningAcknowledgement: requireText(warningAcknowledgement, 'Warning acknowledgement') }
      : {}),
    alternatives: Object.freeze(alternatives),
    decidedBy: requireText(input.decidedBy, 'Decision author'),
    decidedAt,
  });
}
