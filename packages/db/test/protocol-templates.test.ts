import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import * as schema from '../src/schema';
import {
  createProtocolTemplateVersion,
  createTenantProtocolTemplate,
  listProtocolTemplates,
  listProtocolTemplateVersions,
  type ProtocolTemplateVersionInput,
} from '../src/services/protocol-templates';

async function createTestDatabase(): Promise<Database> {
  const databasePath = `/tmp/masters-protocol-templates-${crypto.randomUUID()}.db`;
  const client = createClient({ url: `file:${databasePath}` });
  await client.batch([
    `CREATE TABLE protocol_templates (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, device_type TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX protocol_template_tenant_device_name_uq ON protocol_templates (tenant_id, device_type, name)`,
    `CREATE TABLE protocol_template_versions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, template_id TEXT NOT NULL, version_number INTEGER NOT NULL, warmup_seconds INTEGER NOT NULL, readiness_seconds INTEGER NOT NULL, stage_seconds INTEGER NOT NULL, pause_seconds INTEGER NOT NULL, sample_target_seconds INTEGER NOT NULL, recovery_seconds INTEGER NOT NULL, default_max_stages INTEGER NOT NULL, partial_inclusion_percent INTEGER NOT NULL, config_json TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX protocol_template_version_uq ON protocol_template_versions (tenant_id, template_id, version_number)`,
    `CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, occurred_at TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, correlation_id TEXT NOT NULL, auth_provider TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]);
  return drizzle(client, { schema }) as Database;
}

const admin = { userId: 'admin-a', role: 'TENANT_ADMIN' };
const trainer = { userId: 'trainer-a', role: 'TRAINER' };
const versionOne: ProtocolTemplateVersionInput = {
  name: 'BikeErg Masters',
  deviceType: 'BIKEERG',
  startPowerWatts: 150,
  incrementWatts: 25,
  warmupSeconds: 600,
  warmupPowerWatts: 100,
  readinessSeconds: 120,
  stageSeconds: 240,
  pauseSeconds: 60,
  sampleTargetSeconds: 30,
  defaultMaxStages: 8,
  abortHints: ['Stop on pain'],
  optionalInputFields: ['ROOM_TEMPERATURE', 'SLEEP_QUALITY'],
};

describe('versioned tenant protocol templates', () => {
  it('creates immutable versions while keeping locked protocol rules', async () => {
    const db = await createTestDatabase();
    const created = await createTenantProtocolTemplate(db, 'tenant-a', admin, versionOne);
    const versionTwo = await createProtocolTemplateVersion(
      db,
      'tenant-a',
      created.template.id,
      admin,
      {
        ...versionOne,
        name: 'BikeErg Masters 2027',
        startPowerWatts: 175,
        incrementWatts: 30,
        stageSeconds: 300,
        optionalInputFields: ['ROOM_TEMPERATURE', 'LACTATE_METER'],
      },
    );

    expect(versionTwo.versionNumber).toBe(2);
    const versions = await listProtocolTemplateVersions(db, 'tenant-a', created.template.id);
    expect(versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(versions.every((version) => version.recoverySeconds === 300)).toBe(true);
    expect(versions.every((version) => version.partialInclusionPercent === 50)).toBe(true);

    expect(JSON.parse(versions[0].configJson)).toMatchObject({
      name: 'BikeErg Masters 2027',
      deviceType: 'BIKEERG',
      startPowerWatts: 175,
      incrementWatts: 30,
      optionalInputFields: ['ROOM_TEMPERATURE', 'LACTATE_METER'],
    });
    expect(JSON.parse(versions[1].configJson)).toMatchObject({
      name: 'BikeErg Masters',
      startPowerWatts: 150,
      incrementWatts: 25,
      optionalInputFields: ['ROOM_TEMPERATURE', 'SLEEP_QUALITY'],
    });

    const [template] = await listProtocolTemplates(db, 'tenant-a');
    expect(template).toMatchObject({ name: 'BikeErg Masters', deviceType: 'BIKEERG' });
    const audit = await db.select().from(schema.auditEvents);
    expect(audit.map((event) => event.action)).toEqual([
      'protocol_template.created',
      'protocol_template.version_created',
    ]);
  });

  it('enforces tenant isolation and tenant-admin authorization', async () => {
    const db = await createTestDatabase();
    await expect(
      createTenantProtocolTemplate(db, 'tenant-a', trainer, versionOne),
    ).rejects.toThrow('Only tenant admins');

    const created = await createTenantProtocolTemplate(db, 'tenant-a', admin, versionOne);
    expect(await listProtocolTemplates(db, 'tenant-b')).toHaveLength(0);
    expect(await listProtocolTemplateVersions(db, 'tenant-b', created.template.id)).toHaveLength(0);
    await expect(
      createProtocolTemplateVersion(db, 'tenant-b', created.template.id, admin, versionOne),
    ).rejects.toThrow('Protocol template not found');

    expect(await listProtocolTemplateVersions(db, 'tenant-a', created.template.id)).toHaveLength(1);
    expect((await db.select().from(schema.auditEvents)).every((event) => event.tenantId === 'tenant-a')).toBe(true);
  });

  it('rejects duplicate identities and invalid editable settings', async () => {
    const db = await createTestDatabase();
    await createTenantProtocolTemplate(db, 'tenant-a', admin, versionOne);

    await expect(
      createTenantProtocolTemplate(db, 'tenant-a', admin, versionOne),
    ).rejects.toThrow('Protocol template already exists');
    await expect(
      createTenantProtocolTemplate(db, 'tenant-a', admin, {
        ...versionOne,
        name: 'Invalid sample timing',
        sampleTargetSeconds: 61,
      }),
    ).rejects.toThrow('Sample target seconds');

    expect(await listProtocolTemplates(db, 'tenant-a')).toHaveLength(1);
    expect(await db.select().from(schema.protocolTemplateVersions)).toHaveLength(1);
  });
});
