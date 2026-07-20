import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps } from './common';

export const tenants = sqliteTable('tenants', {
  id: id(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  deploymentMode: text('deployment_mode', { enum: ['CLUB', 'SAAS'] }).notNull(),
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  locale: text('locale').notNull().default('de'),
  retentionYears: integer('retention_years').notNull().default(10),
  ...timestamps,
}, (t) => [uniqueIndex('tenants_slug_uq').on(t.slug)]);

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  preferredLocale: text('preferred_locale').notNull().default('de'),
  disabledAt: text('disabled_at'),
  ...timestamps,
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

export const userIdentities = sqliteTable('user_identities', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider', { enum: ['BETTER_AUTH', 'CLERK'] }).notNull(),
  providerSubject: text('provider_subject').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('identity_provider_subject_uq').on(t.provider, t.providerSubject)]);

export const tenantMemberships = sqliteTable('tenant_memberships', {
  id: id(),
  tenantId: tenantId().references(() => tenants.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'TRAINER', 'ATHLETE'] }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('membership_tenant_user_role_uq').on(t.tenantId, t.userId, t.role)]);
