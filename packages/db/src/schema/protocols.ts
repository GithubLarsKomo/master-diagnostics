import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps } from './common';

export const protocolTemplates = sqliteTable('protocol_templates', {
  id: id(), tenantId: tenantId(), deviceType: text('device_type', { enum: ['BIKEERG','ROWERG','RP3'] }).notNull(),
  name: text('name').notNull(), active: integer('active', { mode: 'boolean' }).notNull().default(true), ...timestamps,
});

export const protocolTemplateVersions = sqliteTable('protocol_template_versions', {
  id: id(), tenantId: tenantId(), templateId: text('template_id').notNull().references(() => protocolTemplates.id),
  versionNumber: integer('version_number').notNull(), warmupSeconds: integer('warmup_seconds').notNull().default(600),
  readinessSeconds: integer('readiness_seconds').notNull().default(120), stageSeconds: integer('stage_seconds').notNull().default(240),
  pauseSeconds: integer('pause_seconds').notNull().default(60), sampleTargetSeconds: integer('sample_target_seconds').notNull().default(30),
  recoverySeconds: integer('recovery_seconds').notNull().default(300), defaultMaxStages: integer('default_max_stages').notNull().default(8),
  partialInclusionPercent: integer('partial_inclusion_percent').notNull().default(50), configJson: text('config_json').notNull().default('{}'),
  createdByUserId: text('created_by_user_id').notNull(), ...timestamps,
}, (t) => [uniqueIndex('protocol_template_version_uq').on(t.tenantId, t.templateId, t.versionNumber)]);

export const zoneRuleVersions = sqliteTable('zone_rule_versions', {
  id: id(), tenantId: tenantId(), versionNumber: integer('version_number').notNull(),
  powerRulesJson: text('power_rules_json').notNull(), heartRateRulesJson: text('heart_rate_rules_json').notNull(),
  activeFrom: text('active_from').notNull(), ...timestamps,
});
