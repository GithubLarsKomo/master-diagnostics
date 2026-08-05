import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { athleteAnonymizationApprovals } from '../schema';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';
import {
  ANONYMIZATION_POLICY_VERSION,
  getAthleteAnonymizationPolicyPreview,
  type AthleteAnonymizationPolicyPreview,
} from './anonymization-policy';
import type { GlobalPrivacyCapabilities } from './global-privacy-policy';
import { getAthleteIrreversibleProcessingPrecheck } from './irreversible-processing';

export const ANONYMIZATION_APPROVAL_VERSION = 1 as const;
export type AnonymizationApprovalFingerprint = `sha256:${string}`;

export interface StoredAthleteAnonymizationApproval {
  id: string;
  tenantId: string;
  athleteId: string;
  deletionRequestId: string;
  approvalVersion: typeof ANONYMIZATION_APPROVAL_VERSION;
  policyVersion: typeof ANONYMIZATION_POLICY_VERSION;
  assessedAt: string;
  scopeFingerprint: AnonymizationApprovalFingerprint;
  capabilityFingerprint: AnonymizationApprovalFingerprint;
  approvedByUserId: string;
  approvedAt: string;
}

export type AnonymizationApprovalValidationBlocker =
  | 'APPROVAL_NOT_FOUND'
  | 'POLICY_VERSION_CHANGED'
  | 'IRREVERSIBLE_PRECHECK_FAILED'
  | 'DELETION_REQUEST_CHANGED'
  | 'SCOPE_FINGERPRINT_CHANGED'
  | 'GLOBAL_PRIVACY_CAPABILITIES_NOT_READY'
  | 'GLOBAL_PRIVACY_CAPABILITY_FINGERPRINT_CHANGED';

export interface AthleteAnonymizationApprovalValidation {
  validForExecutionPreparation: boolean;
  validatedAt: string;
  approvalId: string;
  blockers: ReadonlyArray<AnonymizationApprovalValidationBlocker>;
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprint values require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported fingerprint value type: ${typeof value}`);
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(value: unknown): Promise<AnonymizationApprovalFingerprint> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 hashing requires the Web Crypto API');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(value)));
  return `sha256:${toHex(digest)}`;
}

function normalizeGlobalCapabilities(capabilities?: Readonly<GlobalPrivacyCapabilities>) {
  const backup = capabilities?.backup;
  const notifications = capabilities?.notifications;
  return Object.freeze({
    backup: backup ? Object.freeze({
      state: backup.state,
      policyVersion: backup.policyVersion ?? null,
      encryptedAtRest: backup.encryptedAtRest ?? null,
      boundedRetentionConfigured: backup.boundedRetentionConfigured ?? null,
      restorePrivacyReconciliation: backup.restorePrivacyReconciliation ?? null,
    }) : null,
    notifications: notifications ? Object.freeze({
      state: notifications.state,
      policyVersion: notifications.policyVersion ?? null,
      subjectScopedPayloadContract: notifications.subjectScopedPayloadContract ?? null,
      directIdentifiersForbidden: notifications.directIdentifiersForbidden ?? null,
      subjectCleanupSupported: notifications.subjectCleanupSupported ?? null,
    }) : null,
  });
}

async function createScopeFingerprint(
  tenantId: string,
  athleteId: string,
  deletionRequestId: string,
  policyPreview: Readonly<AthleteAnonymizationPolicyPreview>,
): Promise<AnonymizationApprovalFingerprint> {
  return fingerprint({
    contract: 'athlete-anonymization-scope-v1',
    tenantId,
    athleteId,
    deletionRequestId,
    policyVersion: policyPreview.policy.policyVersion,
    scopes: [...policyPreview.preview.scopes]
      .map((item) => ({
        scope: item.scope,
        rowCount: item.rowCount,
        references: [...item.references].sort(),
      }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
    decisions: [...policyPreview.policy.decisions]
      .map((item) => ({
        scope: item.scope,
        disposition: item.disposition,
        gate: item.gate,
        rowCount: item.rowCount,
      }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
  });
}

async function createCapabilityFingerprint(
  capabilities: Readonly<GlobalPrivacyCapabilities> | undefined,
  policyPreview: Readonly<AthleteAnonymizationPolicyPreview>,
): Promise<AnonymizationApprovalFingerprint> {
  return fingerprint({
    contract: 'athlete-anonymization-global-capabilities-v1',
    requiredGlobalCapabilities: [...policyPreview.policy.requiredGlobalCapabilities].sort(),
    backupPolicyVersion: policyPreview.globalPrivacy.backupPolicyVersion,
    notificationPolicyVersion: policyPreview.globalPrivacy.notificationPolicyVersion,
    capabilities: normalizeGlobalCapabilities(capabilities),
  });
}

function stored(row: typeof athleteAnonymizationApprovals.$inferSelect): Readonly<StoredAthleteAnonymizationApproval> {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId,
    athleteId: row.athleteId,
    deletionRequestId: row.deletionRequestId,
    approvalVersion: ANONYMIZATION_APPROVAL_VERSION,
    policyVersion: ANONYMIZATION_POLICY_VERSION,
    assessedAt: row.assessedAt,
    scopeFingerprint: row.scopeFingerprint as AnonymizationApprovalFingerprint,
    capabilityFingerprint: row.capabilityFingerprint as AnonymizationApprovalFingerprint,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
  });
}

/**
 * Persists an immutable Tenant-Admin approval for exactly the currently reviewed
 * anonymization scope and global privacy capability state. This does not execute
 * any deletion, redaction or anonymization action.
 */
export async function approveAthleteAnonymization(
  db: Database,
  tenantId: string,
  athleteId: string,
  actor: AuditActorContext,
  globalCapabilities: Readonly<GlobalPrivacyCapabilities>,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<StoredAthleteAnonymizationApproval>> {
  if (actor.role !== 'TENANT_ADMIN') throw new Error('Tenant admin role required');
  if (!Number.isFinite(Date.parse(assessedAt))) throw new Error('Assessment time must be a valid ISO-8601 timestamp');

  const [precheck, policyPreview] = await Promise.all([
    getAthleteIrreversibleProcessingPrecheck(db, tenantId, athleteId, assessedAt),
    getAthleteAnonymizationPolicyPreview(db, tenantId, athleteId, assessedAt, globalCapabilities),
  ]);

  if (!precheck.passesPrecheck || !policyPreview.preview.passesIrreversiblePrecheck) {
    throw new Error('Irreversible processing precheck has not passed');
  }
  if (!precheck.state.completedDeletionRequestId) {
    throw new Error('Completed deletion request is required');
  }
  if (!policyPreview.globalPrivacy.readyForIrreversibleProcessing) {
    throw new Error('Global privacy capabilities are not ready');
  }
  if (policyPreview.policy.unresolvedScopes.length > 0
    || policyPreview.policy.unresolvedGlobalRequirements.length > 0
    || policyPreview.policy.blockers.some((blocker) => blocker !== 'ADMINISTRATIVE_APPROVAL_REQUIRED')) {
    throw new Error('Anonymization policy is not ready for administrative approval');
  }

  const deletionRequestId = precheck.state.completedDeletionRequestId;
  const [scopeFingerprint, capabilityFingerprint] = await Promise.all([
    createScopeFingerprint(tenantId, athleteId, deletionRequestId, policyPreview),
    createCapabilityFingerprint(globalCapabilities, policyPreview),
  ]);
  const approvedAt = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    athleteId,
    deletionRequestId,
    approvalVersion: ANONYMIZATION_APPROVAL_VERSION,
    policyVersion: ANONYMIZATION_POLICY_VERSION,
    assessedAt,
    scopeFingerprint,
    capabilityFingerprint,
    approvedByUserId: actor.userId,
    approvedAt,
    createdAt: approvedAt,
    updatedAt: approvedAt,
  };

  await db.transaction(async (tx) => {
    await tx.insert(athleteAnonymizationApprovals).values(row);
    await appendAuditEvent(tx, {
      tenantId,
      ...auditActorFields(actor),
      action: 'athlete.anonymization_approved',
      entityType: 'athlete_anonymization_approval',
      entityId: row.id,
      source: 'WEB',
      after: {
        approvalVersion: row.approvalVersion,
        policyVersion: row.policyVersion,
        athleteId,
        deletionRequestId,
        assessedAt,
        scopeFingerprint,
        capabilityFingerprint,
      },
      occurredAt: approvedAt,
    });
  });

  return stored(row);
}

/**
 * Revalidates an immutable approval against a fresh precheck, fresh scope and
 * fresh global privacy attestation. The result is preparation-only: a future
 * writer still owns transactionality and irreversible execution.
 */
export async function validateAthleteAnonymizationApproval(
  db: Database,
  tenantId: string,
  athleteId: string,
  approvalId: string,
  globalCapabilities: Readonly<GlobalPrivacyCapabilities>,
  validatedAt = new Date().toISOString(),
): Promise<Readonly<AthleteAnonymizationApprovalValidation>> {
  if (!Number.isFinite(Date.parse(validatedAt))) throw new Error('Validation time must be a valid ISO-8601 timestamp');
  const [approval] = await db.select().from(athleteAnonymizationApprovals).where(and(
    eq(athleteAnonymizationApprovals.id, approvalId),
    eq(athleteAnonymizationApprovals.tenantId, tenantId),
    eq(athleteAnonymizationApprovals.athleteId, athleteId),
  )).limit(1);

  if (!approval) {
    return Object.freeze({
      validForExecutionPreparation: false,
      validatedAt,
      approvalId,
      blockers: Object.freeze(['APPROVAL_NOT_FOUND' as const]),
    });
  }

  const blockers: AnonymizationApprovalValidationBlocker[] = [];
  if (approval.approvalVersion !== ANONYMIZATION_APPROVAL_VERSION
    || approval.policyVersion !== ANONYMIZATION_POLICY_VERSION) {
    blockers.push('POLICY_VERSION_CHANGED');
  }

  const [precheck, policyPreview] = await Promise.all([
    getAthleteIrreversibleProcessingPrecheck(db, tenantId, athleteId, validatedAt),
    getAthleteAnonymizationPolicyPreview(db, tenantId, athleteId, validatedAt, globalCapabilities),
  ]);
  if (!precheck.passesPrecheck || !policyPreview.preview.passesIrreversiblePrecheck) {
    blockers.push('IRREVERSIBLE_PRECHECK_FAILED');
  }
  if (precheck.state.completedDeletionRequestId !== approval.deletionRequestId) {
    blockers.push('DELETION_REQUEST_CHANGED');
  }
  if (!policyPreview.globalPrivacy.readyForIrreversibleProcessing) {
    blockers.push('GLOBAL_PRIVACY_CAPABILITIES_NOT_READY');
  }

  const [scopeFingerprint, capabilityFingerprint] = await Promise.all([
    createScopeFingerprint(tenantId, athleteId, approval.deletionRequestId, policyPreview),
    createCapabilityFingerprint(globalCapabilities, policyPreview),
  ]);
  if (scopeFingerprint !== approval.scopeFingerprint) blockers.push('SCOPE_FINGERPRINT_CHANGED');
  if (capabilityFingerprint !== approval.capabilityFingerprint) {
    blockers.push('GLOBAL_PRIVACY_CAPABILITY_FINGERPRINT_CHANGED');
  }

  return Object.freeze({
    validForExecutionPreparation: blockers.length === 0,
    validatedAt,
    approvalId,
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
}
