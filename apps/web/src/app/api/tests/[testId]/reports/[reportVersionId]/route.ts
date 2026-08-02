import { authorize } from '@masters/domain';
import { db } from '@/lib/db';
import { createDatabaseReportDeliveryService } from '@/lib/server/report-delivery-service';
import { getTenantContext } from '@/lib/tenant-context';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ testId: string; reportVersionId: string }> },
) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  const { testId, reportVersionId } = await params;
  const report = await createDatabaseReportDeliveryService(db)
    .download(context.tenantId, testId, reportVersionId);
  if (!report) return new Response('Not found', { status: 404 });

  const filename = `report-${report.version.locale}-v${report.version.versionNumber}.pdf`;
  const body = Uint8Array.from(report.bytes).buffer;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
