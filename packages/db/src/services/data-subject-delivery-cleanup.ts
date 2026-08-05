import type { Database } from '../client';
import { tenantHasActiveAnonymizationExecution } from './anonymization-execution';
import {
  listAthleteDataSubjectDeliveryCleanupCandidates,
  removeAthleteDataSubjectDeliveryPackageRecord,
} from './data-subject-delivery-packages';

export interface DataSubjectDeliveryCleanupStorage {
  remove(reference: string): Promise<void>;
}

export interface DataSubjectDeliveryCleanupSummary {
  assessedAt: string;
  candidateCount: number;
  removedCount: number;
  skippedActiveAnonymizationCount: number;
}

/**
 * Physically removes consumed/expired subject-delivery artifacts before their
 * metadata rows. A tenant with PREPARING/ARTIFACTS_STAGED anonymization is
 * skipped so its durable artifact manifest cannot be invalidated by routine
 * maintenance.
 */
export async function cleanupUnavailableAthleteDataSubjectDeliveryPackages(
  db: Database,
  storage: DataSubjectDeliveryCleanupStorage,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<DataSubjectDeliveryCleanupSummary>> {
  const candidates = await listAthleteDataSubjectDeliveryCleanupCandidates(db, assessedAt);
  let removedCount = 0;
  let skippedActiveAnonymizationCount = 0;

  for (const candidate of candidates) {
    if (await tenantHasActiveAnonymizationExecution(db, candidate.tenantId)) {
      skippedActiveAnonymizationCount += 1;
      continue;
    }

    // File first: if storage removal fails, keep the DB row so the artifact
    // remains discoverable and the operation can be retried safely.
    await storage.remove(candidate.storageReference);
    const removed = await removeAthleteDataSubjectDeliveryPackageRecord(
      db,
      candidate.tenantId,
      candidate.athleteId,
      candidate.id,
    );
    if (removed) removedCount += 1;
  }

  return Object.freeze({
    assessedAt,
    candidateCount: candidates.length,
    removedCount,
    skippedActiveAnonymizationCount,
  });
}
