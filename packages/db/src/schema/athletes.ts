import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, tenantId, timestamps, version } from './common';
import { users } from './identity';

export const athletes = sqliteTable('athletes', {
  id: id(),
  tenantId: tenantId(),
  linkedUserId: text('linked_user_id').references(() => users.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  birthDate: text('birth_date').notNull(),
  referenceCategory: text('reference_category').notNull(),
  heightCm: integer('height_cm').notNull(),
  currentWeightKgX100: integer('current_weight_kg_x100').notNull(),
  primarySport: text('primary_sport').notNull(),
  primaryDiscipline: text('primary_discipline').notNull(),
  trainingStatus: text('training_status').notNull(),
  consentBlockedAt: text('consent_blocked_at'),
  deletedAt: text('deleted_at'),
  ...timestamps,
}, (t) => [uniqueIndex('athlete_tenant_linked_user_uq').on(t.tenantId, t.linkedUserId)]);

export const athleteSnapshots = sqliteTable('athlete_snapshots', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  snapshotJson: text('snapshot_json').notNull(), version: version(), ...timestamps,
});

export const coachAthleteAssignments = sqliteTable('coach_athlete_assignments', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  coachUserId: text('coach_user_id').notNull().references(() => users.id),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  validFrom: text('valid_from').notNull(), validUntil: text('valid_until'), ...timestamps,
}, (t) => [uniqueIndex('assignment_active_uq').on(t.tenantId, t.athleteId, t.coachUserId, t.validFrom)]);

export const consents = sqliteTable('consents', {
  id: id(), tenantId: tenantId(), athleteId: text('athlete_id').notNull().references(() => athletes.id),
  consentType: text('consent_type').notNull(), status: text('status', { enum: ['GRANTED','WITHDRAWN','EXPIRED'] }).notNull(),
  grantedAt: text('granted_at'), withdrawnAt: text('withdrawn_at'), documentVersion: text('document_version').notNull(), ...timestamps,
});

export const athleteGuardians = sqliteTable('athlete_guardians', {
  id: id(),
  tenantId: tenantId(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id),
  fullName: text('full_name').notNull(),
  relationship: text('relationship').notNull(),
  email: text('email'),
  phone: text('phone'),
  authorityConfirmedAt: text('authority_confirmed_at').notNull(),
  validUntil: text('valid_until'),
  revokedAt: text('revoked_at'),
  ...timestamps,
}, (t) => [uniqueIndex('guardian_active_identity_uq').on(t.tenantId, t.athleteId, t.fullName, t.authorityConfirmedAt)]);
