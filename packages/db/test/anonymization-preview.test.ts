import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/irreversible-processing', () => ({
  getAthleteIrreversibleProcessingPrecheck: vi.fn(async (_db, tenantId: string, athleteId: string, assessedAt: string) => ({
    mode: 'READ_ONLY',
    tenantId,
    athleteId,
    assessedAt,
    passesPrecheck: true,
    blockers: [],
    retention: {},
    state: {},
  })),
}));

vi.mock('../src/services/audit-privacy-inventory', () => ({
  inventoryAthleteAuditPrivacyMaintenance: vi.fn(async (_db, tenantId: string, athleteId: string) => ({
    mode: 'READ_ONLY',
    tenantId,
    athleteId,
    scannedEventCount: 3,
    candidateCount: 2,
    identifierClassCount: 2,
    candidates: [
      { auditEventId: 'audit-b', occurredAt: '2025-01-02T00:00:00.000Z', action: 'athlete.updated', entityType: 'athlete', entityId: athleteId, matches: [] },
      { auditEventId: 'audit-a', occurredAt: '2025-01-01T00:00:00.000Z', action: 'athlete.created', entityType: 'athlete', entityId: athleteId, matches: [] },
    ],
  })),
}));

import type { Database } from '../src/client';
import { getAthleteAnonymizationPreview } from '../src/services/anonymization-preview';

const tableCounts: Record<string, number> = {
  athlete_snapshots: 2,
  coach_athlete_assignments: 1,
  consents: 1,
  athlete_guardians: 1,
  athlete_deletion_requests: 1,
  tests: 2,
  test_plan_snapshots: 2,
  test_safety_checklist_confirmations: 2,
  test_termination_events: 1,
  test_stages: 10,
  rest_measurements: 2,
  recovery_measurements: 2,
  test_locks: 0,
  sync_operations: 4,
  quality_flags: 3,
  measurement_corrections: 1,
  threshold_runs: 2,
  threshold_results: 4,
  diagnostic_result_snapshots: 2,
  interpretations: 2,
  zone_profiles: 2,
  report_versions: 2,
  audit_event_privacy_redactions: 1,
};

function fakeDatabase(executed: Array<{ sql: string; args: unknown[] }>): Database {
  return {
    $client: {
      execute: vi.fn(async ({ sql, args }: { sql: string; args: unknown[] }) => {
        executed.push({ sql, args });
        if (sql.includes('SELECT storage_reference FROM report_versions')) {
          return { rows: [{ storage_reference: 'reports/b.pdf' }, { storage_reference: 'reports/a.pdf' }] };
        }
        if (sql.includes('SELECT storage_reference FROM tenant_export_packages')) {
          return { rows: [{ storage_reference: 'exports/tenant-current.zip' }] };
        }
        const table = Object.keys(tableCounts).find((name) => sql.includes(`FROM ${name}`));
        return { rows: [{ count: table ? tableCounts[table] : 0 }] };
      }),
    },
  } as unknown as Database;
}

describe('athlete anonymization preview', () => {
  it('builds a deterministic tenant-scoped read-only scope without deciding diagnostic deletion', async () => {
    const executed: Array<{ sql: string; args: unknown[] }> = [];
    const assessedAt = '2026-08-05T12:00:00.000Z';
    const preview = await getAthleteAnonymizationPreview(
      fakeDatabase(executed),
      'tenant-a',
      'athlete-a',
      assessedAt,
    );

    expect(preview.mode).toBe('READ_ONLY');
    expect(preview.passesIrreversiblePrecheck).toBe(true);
    expect(preview.precheckBlockers).toEqual([]);
    expect(preview.reportArtifactReferences).toEqual(['reports/a.pdf', 'reports/b.pdf']);
    expect(preview.activeTenantExportPackageReferences).toEqual(['exports/tenant-current.zip']);
    expect(preview.auditPrivacyCandidateEventIds).toEqual(['audit-a', 'audit-b']);

    expect(preview.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'ATHLETE_PROFILE', disposition: 'DIRECT_IDENTIFIER_REDACTION_REQUIRED', rowCount: 1 }),
      expect.objectContaining({ scope: 'ATHLETE_SNAPSHOTS', disposition: 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', rowCount: 2 }),
      expect.objectContaining({ scope: 'TEST_PLAN_SNAPSHOTS', disposition: 'EMBEDDED_IDENTIFIER_REWRITE_REQUIRED', rowCount: 2 }),
      expect.objectContaining({ scope: 'RELATIONSHIP_AND_PRIVACY_RECORDS', disposition: 'RELATIONSHIP_DATA_POLICY_REQUIRED', rowCount: 4 }),
      expect.objectContaining({ scope: 'DIAGNOSTIC_AND_OPERATIONAL_RECORDS', disposition: 'REIDENTIFICATION_RISK_REVIEW_REQUIRED' }),
      expect.objectContaining({ scope: 'REPORT_DATABASE_RECORDS', disposition: 'EXTERNAL_ARTIFACT_HANDLING_REQUIRED', rowCount: 2 }),
      expect.objectContaining({ scope: 'AUDIT_PRIVACY_CANDIDATES', disposition: 'AUDIT_PRIVACY_REDACTION_REQUIRED', rowCount: 2 }),
      expect.objectContaining({ scope: 'ACTIVE_TENANT_EXPORT_PACKAGES', disposition: 'EPHEMERAL_EXPORT_CLEANUP_REQUIRED', rowCount: 1 }),
    ]));

    expect(preview.globalRequirements).toEqual([
      'REPORT_STORAGE_VERIFICATION',
      'BACKUP_RETENTION_POLICY_REVIEW',
      'NOTIFICATION_PAYLOAD_REVIEW',
    ]);

    expect(executed.length).toBeGreaterThan(20);
    expect(executed.every(({ sql }) => /^SELECT\s/i.test(sql.trim()))).toBe(true);
    expect(executed.every(({ args }) => args.includes('tenant-a'))).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('firstName');
    expect(JSON.stringify(preview)).not.toContain('lastName');
    expect(JSON.stringify(preview)).not.toContain('birthDate');
  });
});
