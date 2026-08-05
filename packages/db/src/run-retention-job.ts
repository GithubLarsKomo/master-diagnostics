import { createDatabase } from './client';
import { buildRetentionJobPlan } from './services/retention';

const tenantId = process.env.RETENTION_JOB_TENANT_ID?.trim() || undefined;
const assessedAt = process.env.RETENTION_JOB_ASSESSED_AT?.trim() || undefined;

const db = createDatabase();
const plan = await buildRetentionJobPlan(db, {
  ...(tenantId ? { tenantId } : {}),
  ...(assessedAt ? { assessedAt } : {}),
});

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
