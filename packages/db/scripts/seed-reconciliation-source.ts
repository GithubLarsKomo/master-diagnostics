import {
  athleteSnapshots,
  diagnosticResultSnapshots,
  interpretations,
  protocolTemplates,
  protocolTemplateVersions,
  reportVersions,
  testPlanSnapshots,
  tests,
  users,
} from '../src/schema';
import { createDatabaseFromConfig } from '../src/client';
import { createAthlete } from '../src/services/athletes';

const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim();
if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL is required');

const now = '2026-08-24T12:00:00.000Z';
const tenantId = 'reconcile-tenant';
const trainerId = 'reconcile-trainer';
const athleteId = 'reconcile-athlete';
const testId = 'reconcile-test';
const interpretationId = 'reconcile-interpretation';
const db = createDatabaseFromConfig({ url: sourceUrl });

await db.run(`
  INSERT INTO tenants(id, slug, name, deployment_mode, timezone, locale, retention_years, created_at, updated_at)
  VALUES ('${tenantId}', '${tenantId}', 'Reconciliation Club', 'CLUB', 'Europe/Berlin', 'de', 10, '${now}', '${now}')
`);

await db.insert(users).values({
  id: trainerId,
  email: 'reconciliation@example.invalid',
  displayName: 'Reconciliation Trainer',
  preferredLocale: 'de',
  disabledAt: null,
  createdAt: now,
  updatedAt: now,
});

await createAthlete(db, tenantId, {
  userId: trainerId,
  role: 'TRAINER',
  authProvider: 'BETTER_AUTH',
  sessionId: 'reconcile-session',
}, {
  id: athleteId,
  firstName: 'Ada',
  lastName: 'Reconcile',
  birthDate: '1986-04-12',
  referenceCategory: 'Masters',
  heightCm: 172,
  currentWeightKgX100: 6450,
  primarySport: 'Rudern',
  primaryDiscipline: 'Einer',
  trainingStatus: 'leistungsorientiert',
});

await db.insert(athleteSnapshots).values({
  id: 'reconcile-athlete-snapshot',
  tenantId,
  athleteId,
  snapshotJson: JSON.stringify({ athleteId, tags: ['migration', 'postgresql'], consent: true }),
  version: 1,
  createdAt: now,
  updatedAt: now,
});

await db.insert(protocolTemplates).values({
  id: 'reconcile-template',
  tenantId,
  deviceType: 'BIKEERG',
  name: 'Reconciliation Bike Test',
  active: true,
  createdAt: now,
  updatedAt: now,
});

await db.insert(protocolTemplateVersions).values({
  id: 'reconcile-template-v1',
  tenantId,
  templateId: 'reconcile-template',
  versionNumber: 1,
  warmupSeconds: 600,
  readinessSeconds: 30,
  stageSeconds: 240,
  pauseSeconds: 60,
  sampleTargetSeconds: 30,
  recoverySeconds: 300,
  defaultMaxStages: 8,
  partialInclusionPercent: 50,
  configJson: JSON.stringify({ audioWarningSeconds: [30, 10, 3], nested: { enabled: true } }),
  createdByUserId: trainerId,
  createdAt: now,
  updatedAt: now,
});

await db.insert(tests).values({
  id: testId,
  tenantId,
  athleteId,
  deviceType: 'BIKEERG',
  status: 'DATA_REVIEW',
  conductingTrainerUserId: trainerId,
  startedAt: now,
  completedAt: '2026-08-24T12:45:00.000Z',
  currentVersion: 3,
  createdAt: now,
  updatedAt: '2026-08-24T12:45:00.000Z',
});

await db.insert(testPlanSnapshots).values({
  id: 'reconcile-plan',
  tenantId,
  testId,
  protocolVersionId: 'reconcile-template-v1',
  athleteSnapshotId: 'reconcile-athlete-snapshot',
  expectedLt2Watts: 285,
  startWatts: 140,
  incrementWatts: 30,
  maximumStages: 8,
  snapshotJson: JSON.stringify({ plan: { powersWatts: [140, 170, 200, 230, 260, 290] }, comment: 'äöü' }),
  createdAt: now,
  updatedAt: now,
});

await db.insert(diagnosticResultSnapshots).values({
  id: 'reconcile-result-snapshot',
  tenantId,
  testId,
  versionNumber: 1,
  schemaVersion: '1',
  canonicalization: 'JCS-like-v1',
  resultHash: '9e4bfac8b83d7f5a8b7c2ff5c56fc2f32efaf6657c462f98b8d8365a6db5c2f9',
  resultJson: JSON.stringify({ lt1: { watts: 210 }, lt2: { watts: 282 }, valid: true }),
  createdAt: '2026-08-24T12:50:00.000Z',
  updatedAt: '2026-08-24T12:50:00.000Z',
});

await db.insert(interpretations).values({
  id: interpretationId,
  tenantId,
  testId,
  versionNumber: 1,
  lt1Json: JSON.stringify({ watts: 210, heartRate: 138 }),
  lt2Json: JSON.stringify({ watts: 282, heartRate: 161 }),
  rationale: 'Released reconciliation fixture',
  status: 'RELEASED',
  releasedAt: '2026-08-24T13:00:00.000Z',
  releasedByUserId: trainerId,
  createdAt: '2026-08-24T12:55:00.000Z',
  updatedAt: '2026-08-24T13:00:00.000Z',
});

await db.insert(reportVersions).values({
  id: 'reconcile-report',
  tenantId,
  testId,
  interpretationId,
  versionNumber: 1,
  locale: 'de',
  contentHash: '2ad8ccdbce4f52f64a4991d10e0df5fe4e88146d5f1a267b7ab927a26672bb57',
  storageReference: 'reports/reconcile-test/v1-de.pdf',
  createdAt: '2026-08-24T13:01:00.000Z',
  updatedAt: '2026-08-24T13:01:00.000Z',
});

process.stdout.write(`${JSON.stringify({ seeded: true, tenantId, athleteId, testId })}\n`);
