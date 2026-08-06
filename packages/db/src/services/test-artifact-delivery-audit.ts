import type { Database } from '../client';
import { appendAuditEvent, auditActorFields, type AuditActorContext } from './audit';

export type TestArtifactDeliveryAuditInput =
  | Readonly<{
    kind: 'TEST_EXPORT';
    format: 'csv' | 'json' | 'markdown';
  }>
  | Readonly<{
    kind: 'ANALYSIS_EXPORT';
    riskLevel: string;
    equivalenceClassSize: number;
  }>
  | Readonly<{
    kind: 'REPORT';
    reportVersionId: string;
    locale: 'de' | 'en';
    versionNumber: number;
    contentHash: string;
  }>;

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

/** Records one successfully prepared authenticated test-artifact delivery. */
export async function auditTestArtifactDelivery(
  db: Database,
  tenantId: string,
  testId: string,
  actor: AuditActorContext,
  delivery: TestArtifactDeliveryAuditInput,
  occurredAt = new Date().toISOString(),
): Promise<void> {
  if (!tenantId.trim() || !testId.trim()) throw new Error('Tenant and test IDs are required');
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('Delivery audit time must be a valid ISO-8601 timestamp');

  if (delivery.kind === 'TEST_EXPORT') {
    await appendAuditEvent(db, {
      tenantId,
      ...auditActorFields(actor),
      action: 'test.export_downloaded',
      entityType: 'test',
      entityId: testId,
      source: 'WEB',
      after: { format: delivery.format },
      occurredAt,
      recordedAt: occurredAt,
    });
    return;
  }

  if (delivery.kind === 'ANALYSIS_EXPORT') {
    requirePositiveInteger(delivery.equivalenceClassSize, 'Equivalence class size');
    await appendAuditEvent(db, {
      tenantId,
      ...auditActorFields(actor),
      action: 'analysis.export_downloaded',
      entityType: 'test',
      entityId: testId,
      source: 'WEB',
      after: {
        riskLevel: delivery.riskLevel,
        equivalenceClassSize: delivery.equivalenceClassSize,
      },
      occurredAt,
      recordedAt: occurredAt,
    });
    return;
  }

  requirePositiveInteger(delivery.versionNumber, 'Report version number');
  if (!/^sha256:[0-9a-f]{64}$/.test(delivery.contentHash)) throw new Error('Report content hash is invalid');
  await appendAuditEvent(db, {
    tenantId,
    ...auditActorFields(actor),
    action: 'report.downloaded',
    entityType: 'report_version',
    entityId: delivery.reportVersionId,
    source: 'WEB',
    after: {
      testId,
      locale: delivery.locale,
      versionNumber: delivery.versionNumber,
      contentHash: delivery.contentHash,
    },
    occurredAt,
    recordedAt: occurredAt,
  });
}
