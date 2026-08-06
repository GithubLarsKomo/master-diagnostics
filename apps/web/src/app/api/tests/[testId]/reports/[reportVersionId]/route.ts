import { auditTestArtifactDelivery, canReadReportForTest } from '@masters/db';
import { db } from '@/lib/db';
import { createDatabaseReportDeliveryService } from '@/lib/server/report-delivery-service';
import { getTenantContext } from '@/lib/tenant-context';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ testId: string; reportVersionId: string }> },
) {
  const context = await getTenantContext();
  const { testId, reportVersionId } = await params;

  if (!(await canReadReportForTest(db, context, testId))) {
    return new Response('Forbidden', { status: 403 });
  }

  const report = await createDatabaseReportDeliveryService(db)
    .download(context.tenantId, testId, reportVersionId);
  if (!report) return new Response('Not found', { status: 404 });

  const filename = `report-${report.version.locale}-v${report.version.versionNumber}.pdf`;
  const body = Uint8Array.from(report.bytes).buffer;

  await auditTestArtifactDelivery(db, context.tenantId, testId, context, {
    kind: 'REPORT',
    reportVersionId: report.version.id,
    locale: report.version.locale,
    versionNumber: report.version.versionNumber,
    contentHash: report.version.contentHash,
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Report-Content-Hash': report.version.contentHash,
    },
  });
}
