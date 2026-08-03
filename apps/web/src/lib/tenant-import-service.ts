import { createHash } from 'node:crypto';
import {
  executePreparedTenantImportPlan,
  prepareTenantImportPlan,
  type Database,
  type ExecutePreparedTenantImportOptions,
  type PrepareTenantImportOptions,
  type TenantImportPlan,
} from '@masters/db';
import type { TenantPortabilityExportDocument } from '@masters/domain';
import type { ReportArtifactStorage } from './report-artifact-storage';

interface PreparedReportArtifact {
  reference: string;
  created: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing string at ${path}`);
  return value;
}

export async function prepareTenantImportReportArtifacts(
  plan: TenantImportPlan,
  document: TenantPortabilityExportDocument,
  storage: ReportArtifactStorage,
): Promise<PreparedReportArtifact[]> {
  const sourceRows = new Map((document.data.report_versions ?? []).map((row) => [requireString(row.id, 'report_versions.id'), row]));
  const targetRows = new Map(plan.tables.report_versions.map((row) => [requireString(row.id, 'target report_versions.id'), row]));
  const prepared: PreparedReportArtifact[] = [];

  try {
    for (const artifact of document.reportArtifacts) {
      const sourceRow = sourceRows.get(artifact.reportVersionId);
      if (!sourceRow) throw new Error(`Missing report_versions row for artifact ${artifact.reportVersionId}`);

      const sourceTestId = requireString(sourceRow.test_id, `report_versions.${artifact.reportVersionId}.test_id`);
      const targetTestId = plan.idMap[sourceTestId];
      const targetReportVersionId = plan.idMap[artifact.reportVersionId];
      if (!targetTestId || !targetReportVersionId) throw new Error(`Missing technical id mapping for report ${artifact.reportVersionId}`);

      const locale = requireString(sourceRow.locale, `report_versions.${artifact.reportVersionId}.locale`);
      if (locale !== 'de' && locale !== 'en') throw new Error(`Unsupported report locale ${locale}`);
      const contentHash = requireString(sourceRow.content_hash, `report_versions.${artifact.reportVersionId}.content_hash`);
      if (contentHash !== `sha256:${artifact.sha256}`) throw new Error(`Report content hash mismatch for ${artifact.reportVersionId}`);

      const bytes = new Uint8Array(Buffer.from(artifact.base64, 'base64'));
      if (sha256(bytes) !== artifact.sha256) throw new Error(`Report artifact checksum mismatch for ${artifact.reportVersionId}`);

      const reference = `${plan.targetTenantId}/${targetTestId}/${locale}/${artifact.sha256}.pdf`;
      const targetRow = targetRows.get(targetReportVersionId);
      if (!targetRow) throw new Error(`Missing remapped report_versions row for ${artifact.reportVersionId}`);
      targetRow.storage_reference = reference;

      let created = false;
      try {
        await storage.put(reference, bytes);
        created = true;
      } catch (error) {
        try {
          const existing = await storage.get(reference);
          if (!equalBytes(existing, bytes)) throw error;
        } catch {
          throw error;
        }
      }
      prepared.push({ reference, created });
    }
    return prepared;
  } catch (error) {
    await Promise.all(prepared.filter((entry) => entry.created).map((entry) => storage.remove(entry.reference)));
    throw error;
  }
}

export async function rollbackPreparedTenantImportReportArtifacts(
  prepared: readonly PreparedReportArtifact[],
  storage: ReportArtifactStorage,
): Promise<void> {
  await Promise.all(prepared.filter((entry) => entry.created).map((entry) => storage.remove(entry.reference)));
}

export async function importTenantPortabilityDocument(
  db: Database,
  storage: ReportArtifactStorage,
  document: TenantPortabilityExportDocument,
  prepareOptions: PrepareTenantImportOptions = {},
  executeOptions: ExecutePreparedTenantImportOptions = {},
): Promise<TenantImportPlan> {
  const plan = await prepareTenantImportPlan(db, document, prepareOptions);
  const prepared = await prepareTenantImportReportArtifacts(plan, document, storage);
  try {
    return await executePreparedTenantImportPlan(db, plan, executeOptions);
  } catch (error) {
    await rollbackPreparedTenantImportReportArtifacts(prepared, storage);
    throw error;
  }
}
