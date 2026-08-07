import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  athleteAnonymizationApprovals,
  athleteAnonymizationExecutions,
} from '../schema';
import type { RestorePrivacyEffectIdentity } from './restore-privacy-effect-journal';

/**
 * Loads the immutable technical identity that a durable privacy-effect journal
 * must bind before an irreversible anonymization DB commit.
 *
 * The join is constrained by tenant, athlete and approval so a foreign or stale
 * approval can never be attached to another execution.
 */
export async function getAthleteAnonymizationPrivacyEffectIdentity(
  db: Database,
  tenantId: string,
  athleteId: string,
  executionId: string,
): Promise<Readonly<RestorePrivacyEffectIdentity> | null> {
  const [row] = await db.select({
    tenantId: athleteAnonymizationExecutions.tenantId,
    athleteId: athleteAnonymizationExecutions.athleteId,
    executionId: athleteAnonymizationExecutions.id,
    approvalId: athleteAnonymizationExecutions.approvalId,
    executionVersion: athleteAnonymizationExecutions.executionVersion,
    deletionRequestId: athleteAnonymizationApprovals.deletionRequestId,
    policyVersion: athleteAnonymizationApprovals.policyVersion,
    scopeFingerprint: athleteAnonymizationApprovals.scopeFingerprint,
    capabilityFingerprint: athleteAnonymizationApprovals.capabilityFingerprint,
  }).from(athleteAnonymizationExecutions)
    .innerJoin(athleteAnonymizationApprovals, and(
      eq(athleteAnonymizationApprovals.id, athleteAnonymizationExecutions.approvalId),
      eq(athleteAnonymizationApprovals.tenantId, athleteAnonymizationExecutions.tenantId),
      eq(athleteAnonymizationApprovals.athleteId, athleteAnonymizationExecutions.athleteId),
    ))
    .where(and(
      eq(athleteAnonymizationExecutions.id, executionId),
      eq(athleteAnonymizationExecutions.tenantId, tenantId),
      eq(athleteAnonymizationExecutions.athleteId, athleteId),
    ))
    .limit(1);

  if (!row) return null;
  return Object.freeze({
    tenantId: row.tenantId,
    athleteId: row.athleteId,
    executionId: row.executionId,
    approvalId: row.approvalId,
    deletionRequestId: row.deletionRequestId,
    executionVersion: row.executionVersion,
    policyVersion: row.policyVersion,
    scopeFingerprint: row.scopeFingerprint,
    capabilityFingerprint: row.capabilityFingerprint,
  });
}
