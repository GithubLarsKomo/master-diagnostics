import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import { bootstrapClub } from '../src/services/club-bootstrap';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-factory-protocols-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });

  await client.batch([
    `CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, deployment_mode TEXT NOT NULL, timezone TEXT NOT NULL, locale TEXT NOT NULL, retention_years INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX tenants_slug_uq ON tenants (slug)`,
    `CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL, preferred_locale TEXT NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX users_email_uq ON users (email)`,
    `CREATE TABLE user_identities (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_subject TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX identity_provider_subject_uq ON user_identities (provider, provider_subject)`,
    `CREATE TABLE tenant_memberships (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX membership_tenant_user_role_uq ON tenant_memberships (tenant_id, user_id, role)`,
    `CREATE TABLE protocol_templates (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, device_type TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX protocol_template_tenant_device_name_uq ON protocol_templates (tenant_id, device_type, name)`,
    `CREATE TABLE protocol_template_versions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, template_id TEXT NOT NULL, version_number INTEGER NOT NULL, warmup_seconds INTEGER NOT NULL, readiness_seconds INTEGER NOT NULL, stage_seconds INTEGER NOT NULL, pause_seconds INTEGER NOT NULL, sample_target_seconds INTEGER NOT NULL, recovery_seconds INTEGER NOT NULL, default_max_stages INTEGER NOT NULL, partial_inclusion_percent INTEGER NOT NULL, config_json TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX protocol_template_version_uq ON protocol_template_versions (tenant_id, template_id, version_number)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);

  return drizzle(client, { schema }) as Database;
}

const bootstrapInput = {
  clubName: 'Masters Test Club',
  slug: 'masters-test-club',
  timezone: 'Europe/Berlin',
  locale: 'de' as const,
  retentionYears: 10,
  admin: {
    authUserId: 'auth-admin',
    email: 'ADMIN@example.test',
    displayName: 'Test Admin',
  },
};

describe('factory protocol template bootstrap', () => {
  it('creates one immutable version for every supported device in the bootstrap transaction', async () => {
    const db = await createTestDatabase();
    const { tenantId, userId } = await bootstrapClub(db, bootstrapInput);

    const templates = await db.select().from(schema.protocolTemplates);
    const versions = await db.select().from(schema.protocolTemplateVersions);

    expect(
      templates
        .map(({ deviceType, name }) => ({ deviceType, name }))
        .sort((left, right) => left.deviceType.localeCompare(right.deviceType)),
    ).toEqual([
      { deviceType: 'BIKEERG', name: 'BikeErg' },
      { deviceType: 'ROWERG', name: 'RowErg' },
      { deviceType: 'RP3', name: 'RP3' },
    ]);
    expect(templates.every((template) => template.tenantId === tenantId && template.active)).toBe(true);
    expect(versions).toHaveLength(3);

    for (const version of versions) {
      expect(version).toMatchObject({
        tenantId,
        versionNumber: 1,
        warmupSeconds: 600,
        readinessSeconds: 120,
        stageSeconds: 240,
        pauseSeconds: 60,
        sampleTargetSeconds: 30,
        recoverySeconds: 300,
        defaultMaxStages: 8,
        partialInclusionPercent: 50,
        createdByUserId: userId,
      });
      const template = templates.find((candidate) => candidate.id === version.templateId);
      expect(template).toBeDefined();
      expect(JSON.parse(version.configJson)).toEqual({
        schemaVersion: 1,
        name: template!.name,
        deviceType: template!.deviceType,
        startPowerWatts: null,
        incrementWatts: null,
        warmupPowerWatts: null,
        abortHints: [],
        optionalInputFields: [],
        audioWarningSeconds: [30, 10, 3],
        restingMeasurement: 'BEFORE_WARMUP',
      });
    }

    const [auditEvent] = await db.select().from(schema.auditEvents);
    expect(auditEvent).toMatchObject({
      actorUserId: userId,
      actorRole: 'TENANT_ADMIN',
      authProvider: 'BETTER_AUTH',
      sessionId: null,
      action: 'club.bootstrap.completed',
      source: 'SETUP_WIZARD',
    });
    expect(JSON.parse(auditEvent.afterJson ?? '{}')).toMatchObject({
      factoryProtocolTemplateCount: 3,
    });
  });

  it('keeps exactly one factory set when a second club bootstrap is rejected', async () => {
    const db = await createTestDatabase();
    await bootstrapClub(db, bootstrapInput);

    await expect(
      bootstrapClub(db, {
        ...bootstrapInput,
        slug: 'another-club',
        admin: { ...bootstrapInput.admin, authUserId: 'another-admin' },
      }),
    ).rejects.toThrow('Club installation is already configured');

    expect(await db.select().from(schema.protocolTemplates)).toHaveLength(3);
    expect(await db.select().from(schema.protocolTemplateVersions)).toHaveLength(3);
  });
});
