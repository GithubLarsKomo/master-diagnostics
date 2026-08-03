import { describe, expect, it } from 'vitest';
import type { TenantPortabilityExportDocument } from '@masters/domain';
import { buildTenantImportPlan } from '../src/services/tenant-import';

function fixture(): TenantPortabilityExportDocument {
  return {
    schemaVersion: 'masters-tenant-export-v1',
    manifest: {
      schemaVersion: 'masters-tenant-export-v1',
      exportedAt: '2026-08-03T10:00:00.000Z',
      tenantId: 'tenant-source',
      sections: {},
      reportArtifacts: [],
    },
    tenant: { id: 'tenant-source', slug: 'source', name: 'Source', created_at: '2026-01-01T00:00:00.000Z' },
    users: [{ id: 'user-source', email: 'admin@example.test', created_at: '2026-01-02T00:00:00.000Z' }],
    memberships: [{
      id: 'membership-source', tenant_id: 'tenant-source', user_id: 'user-source', role: 'TENANT_ADMIN',
      created_at: '2026-01-03T00:00:00.000Z',
    }],
    data: {
      athletes: [{
        id: 'athlete-source', tenant_id: 'tenant-source', linked_user_id: 'user-source', first_name: 'Max',
        created_at: '2026-01-04T00:00:00.000Z',
      }],
      tests: [{
        id: 'test-source', tenant_id: 'tenant-source', athlete_id: 'athlete-source', created_by_user_id: 'user-source',
        started_at: '2026-01-05T10:00:00.000Z', created_at: '2026-01-05T09:00:00.000Z',
      }],
    } as TenantPortabilityExportDocument['data'],
    reportArtifacts: [],
    dataDictionary: {},
  };
}

describe('tenant import plan', () => {
  it('remaps technical ids and references while preserving domain values and timestamps', () => {
    const plan = buildTenantImportPlan(fixture(), 'tenant-target');

    expect(plan.sourceTenantId).toBe('tenant-source');
    expect(plan.targetTenantId).toBe('tenant-target');
    expect(plan.tenant.id).toBe('tenant-target');
    expect(plan.tenant.created_at).toBe('2026-01-01T00:00:00.000Z');

    const mappedUserId = plan.idMap['user-source'];
    const mappedAthleteId = plan.idMap['athlete-source'];
    expect(mappedUserId).toBeTruthy();
    expect(mappedUserId).not.toBe('user-source');
    expect(mappedAthleteId).toBeTruthy();

    expect(plan.users[0]?.id).toBe(mappedUserId);
    expect(plan.users[0]?.email).toBe('admin@example.test');
    expect(plan.memberships[0]).toMatchObject({ tenant_id: 'tenant-target', user_id: mappedUserId });
    expect(plan.tables.athletes[0]).toMatchObject({
      id: mappedAthleteId,
      tenant_id: 'tenant-target',
      linked_user_id: mappedUserId,
      first_name: 'Max',
      created_at: '2026-01-04T00:00:00.000Z',
    });
    expect(plan.tables.tests[0]).toMatchObject({
      tenant_id: 'tenant-target',
      athlete_id: mappedAthleteId,
      created_by_user_id: mappedUserId,
      started_at: '2026-01-05T10:00:00.000Z',
    });
  });

  it('rejects ambiguous duplicate technical ids before any write can occur', () => {
    const document = fixture();
    document.users.push({ id: 'athlete-source', email: 'collision@example.test' });
    expect(() => buildTenantImportPlan(document, 'tenant-target')).toThrow(/Duplicate technical id athlete-source/);
  });
});
