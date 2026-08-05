import { createDatabase } from './client';
import { buildRetentionJobPlan } from './services/retention';
import { summarizeRetentionJobPlan } from './services/retention-job-output';

const tenantId = process.env.RETENTION_JOB_TENANT_ID?.trim() || undefined;
const assessedAt = process.env.RETENTION_JOB_ASSESSED_AT?.trim() || undefined;
const outputMode = process.env.RETENTION_JOB_OUTPUT?.trim().toLowerCase() || 'full';
if (outputMode !== 'full' && outputMode !== 'summary') {
  throw new Error('RETENTION_JOB_OUTPUT must be full or summary');
}

const db = createDatabase();
const plan = await buildRetentionJobPlan(db, {
  ...(tenantId ? { tenantId } : {}),
  ...(assessedAt ? { assessedAt } : {}),
});
const output = outputMode === 'summary' ? summarizeRetentionJobPlan(plan) : plan;

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
