import type { Database } from '../client';
import { inventoryAthleteAuditPrivacyMaintenance } from './audit-privacy-inventory';
import { getAthleteIrreversibleProcessingPrecheck } from './irreversible-processing';

export type AnonymizationPreviewDisposition =
  | 'DIRECT_IDENTIFIER_REDACTION_REQUIRED'
  | 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED'
  | 'RELATIONSHIP_LINK_REMOVAL_REQUIRED'
  | 'MINIMIZED_COMPLIANCE_RECORD_REQUIRED'
  | 'THIRD_PARTY_RECORD_REMOVAL_REQUIRED'
  | 'FREE_TEXT_REDACTION_REQUIRED'
  | 'REIDENTIFICATION_RISK_REVIEW_REQUIRED'
  | 'EXTERNAL_ARTIFACT_HANDLING_REQUIRED'
  | 'AUDIT_PRIVACY_REDACTION_REQUIRED'
  | 'EPHEMERAL_EXPORT_CLEANUP_REQUIRED';

export interface AnonymizationPreviewScope {
  scope: string;
  disposition: AnonymizationPreviewDisposition;
  rowCount: number;
  references: ReadonlyArray<string>;
}

export interface AthleteAnonymizationPreview {
  mode: 'READ_ONLY';
  tenantId: string;
  athleteId: string;
  assessedAt: string;
  passesIrreversiblePrecheck: boolean;
  precheckBlockers: ReadonlyArray<string>;
  scopes: ReadonlyArray<Readonly<AnonymizationPreviewScope>>;
  totalScopedRows: number;
  reportArtifactReferences: ReadonlyArray<string>;
  activeTenantExportPackageReferences: ReadonlyArray<string>;
  auditPrivacyCandidateEventIds: ReadonlyArray<string>;
  globalRequirements: ReadonlyArray<
    | 'REPORT_STORAGE_VERIFICATION'
    | 'BACKUP_RETENTION_POLICY_REVIEW'
    | 'NOTIFICATION_PAYLOAD_REVIEW'
  >;
}

async function count(
  db: Database,
  sql: string,
  args: readonly (string | number | null)[],
): Promise<number> {
  const result = await db.$client.execute({ sql, args: [...args] });
  return Number(result.rows[0]?.count ?? 0);
}

async function stringColumn(
  db: Database,
  sql: string,
  args: readonly (string | number | null)[],
  column: string,
): Promise<string[]> {
  const result = await db.$client.execute({ sql, args: [...args] });
  return result.rows
    .map((row) => row[column])
    .filter((value): value is string => typeof value === 'string')
    .sort();
}

function scope(
  name: string,
  disposition: AnonymizationPreviewDisposition,
  rowCount: number,
  references: readonly string[] = [],
): Readonly<AnonymizationPreviewScope> {
  return Object.freeze({
    scope: name,
    disposition,
    rowCount,
    references: Object.freeze([...references].sort()),
  });
}

const athleteTestSubquery = 'SELECT id FROM tests WHERE tenant_id = ? AND athlete_id = ?';

/**
 * Produces a comprehensive, deterministic and completely read-only inventory of
 * data classes that a future irreversible athlete anonymization writer must
 * address. It intentionally does not decide whether diagnostic data should be
 * deleted, generalized or retained under a non-reversible technical linkage.
 */
export async function getAthleteAnonymizationPreview(
  db: Database,
  tenantId: string,
  athleteId: string,
  assessedAt = new Date().toISOString(),
): Promise<Readonly<AthleteAnonymizationPreview>> {
  const precheck = await getAthleteIrreversibleProcessingPrecheck(
    db,
    tenantId,
    athleteId,
    assessedAt,
  );
  const auditInventory = await inventoryAthleteAuditPrivacyMaintenance(
    db,
    tenantId,
    athleteId,
  );

  const [
    athleteSnapshots,
    coachAssignments,
    consents,
    guardians,
    deletionRequests,
    tests,
    testPlanSnapshots,
    safetyConfirmations,
    terminationEvents,
    testStages,
    restMeasurements,
    recoveryMeasurements,
    testLocks,
    syncOperations,
    qualityFlags,
    measurementCorrections,
    thresholdRuns,
    thresholdResults,
    diagnosticSnapshots,
    interpretations,
    zoneProfiles,
    reportVersions,
    priorAuditRedactions,
  ] = await Promise.all([
    count(db, 'SELECT count(*) AS count FROM athlete_snapshots WHERE tenant_id = ? AND athlete_id = ?', [tenantId, athleteId]),
    count(db, 'SELECT count(*) AS count FROM coach_athlete_assignments WHERE tenant_id = ? AND athlete_id = ?', [tenantId, athleteId]),
    count(db, 'SELECT count(*) AS count FROM consents WHERE tenant_id = ? AND athlete_id = ?', [tenantId, athleteId]),
    count(db, 'SELECT count(*) AS count FROM athlete_guardians WHERE tenant_id = ? AND athlete_id = ?', [tenantId, athleteId]),
    count(db, 'SELECT count(*) AS count FROM athlete_deletion_requests WHERE tenant_id = ? AND athlete_id = ?', [tenantId, athleteId]),
    count(db, 'SELECT count(*) AS count FROM tests WHERE tenant_id = ? AND athlete_id = ?', [tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM test_plan_snapshots WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM test_safety_checklist_confirmations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM test_termination_events WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM test_stages WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM rest_measurements WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM recovery_measurements WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM test_locks WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM sync_operations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM quality_flags WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM measurement_corrections WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM threshold_runs WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM threshold_results WHERE tenant_id = ? AND threshold_run_id IN (SELECT id FROM threshold_runs WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}))`, [tenantId, tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM diagnostic_result_snapshots WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM interpretations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM zone_profiles WHERE tenant_id = ? AND interpretation_id IN (SELECT id FROM interpretations WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}))`, [tenantId, tenantId, tenantId, athleteId]),
    count(db, `SELECT count(*) AS count FROM report_versions WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery})`, [tenantId, tenantId, athleteId]),
    count(db, 'SELECT count(*) AS count FROM audit_event_privacy_redactions WHERE tenant_id = ? AND subject_athlete_id = ?', [tenantId, athleteId]),
  ]);

  const [reportArtifactReferences, activeTenantExportPackageReferences] = await Promise.all([
    stringColumn(
      db,
      `SELECT storage_reference FROM report_versions WHERE tenant_id = ? AND test_id IN (${athleteTestSubquery}) ORDER BY storage_reference`,
      [tenantId, tenantId, athleteId],
      'storage_reference',
    ),
    stringColumn(
      db,
      'SELECT storage_reference FROM tenant_export_packages WHERE tenant_id = ? AND expires_at > ? ORDER BY storage_reference',
      [tenantId, assessedAt],
      'storage_reference',
    ),
  ]);

  const diagnosticRows = tests
    + safetyConfirmations
    + terminationEvents
    + testStages
    + restMeasurements
    + recoveryMeasurements
    + testLocks
    + syncOperations
    + qualityFlags
    + measurementCorrections
    + thresholdRuns
    + thresholdResults
    + diagnosticSnapshots
    + interpretations
    + zoneProfiles;

  const auditCandidateIds = auditInventory.candidates
    .map((candidate) => candidate.auditEventId)
    .sort();

  const scopes = [
    scope('ATHLETE_PROFILE', 'DIRECT_IDENTIFIER_REDACTION_REQUIRED', 1),
    scope('ATHLETE_SNAPSHOTS', 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', athleteSnapshots),
    scope('TEST_PLAN_SNAPSHOTS', 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', testPlanSnapshots),
    scope('COACH_ASSIGNMENTS', 'RELATIONSHIP_LINK_REMOVAL_REQUIRED', coachAssignments),
    scope('CONSENT_RECORDS', 'MINIMIZED_COMPLIANCE_RECORD_REQUIRED', consents),
    scope('GUARDIAN_RECORDS', 'THIRD_PARTY_RECORD_REMOVAL_REQUIRED', guardians),
    scope('DELETION_REQUESTS', 'FREE_TEXT_REDACTION_REQUIRED', deletionRequests),
    scope('DIAGNOSTIC_AND_OPERATIONAL_RECORDS', 'REIDENTIFICATION_RISK_REVIEW_REQUIRED', diagnosticRows),
    scope('REPORT_DATABASE_RECORDS', 'EXTERNAL_ARTIFACT_HANDLING_REQUIRED', reportVersions, reportArtifactReferences),
    scope('AUDIT_PRIVACY_CANDIDATES', 'AUDIT_PRIVACY_REDACTION_REQUIRED', auditCandidateIds.length, auditCandidateIds),
    scope('PRIOR_AUDIT_REDACTION_PROOFS', 'AUDIT_PRIVACY_REDACTION_REQUIRED', priorAuditRedactions),
    scope('ACTIVE_TENANT_EXPORT_PACKAGES', 'EPHEMERAL_EXPORT_CLEANUP_REQUIRED', activeTenantExportPackageReferences.length, activeTenantExportPackageReferences),
  ];

  return Object.freeze({
    mode: 'READ_ONLY' as const,
    tenantId,
    athleteId,
    assessedAt,
    passesIrreversiblePrecheck: precheck.passesPrecheck,
    precheckBlockers: Object.freeze([...precheck.blockers]),
    scopes: Object.freeze(scopes),
    totalScopedRows: scopes.reduce((sum, item) => sum + item.rowCount, 0),
    reportArtifactReferences: Object.freeze(reportArtifactReferences),
    activeTenantExportPackageReferences: Object.freeze(activeTenantExportPackageReferences),
    auditPrivacyCandidateEventIds: Object.freeze(auditCandidateIds),
    globalRequirements: Object.freeze([
      'REPORT_STORAGE_VERIFICATION' as const,
      'BACKUP_RETENTION_POLICY_REVIEW' as const,
      'NOTIFICATION_PAYLOAD_REVIEW' as const,
    ]),
  });
}
