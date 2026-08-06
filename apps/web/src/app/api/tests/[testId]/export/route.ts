import { createTestExportDocument, renderTestExport, type TestExportFormat } from '@masters/domain';
import { auditTestArtifactDelivery, canReadReportForTest, getTestExportSource } from '@masters/db';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const formats: Record<TestExportFormat, { contentType: string; extension: string }> = {
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv' },
  json: { contentType: 'application/json; charset=utf-8', extension: 'json' },
  markdown: { contentType: 'text/markdown; charset=utf-8', extension: 'md' },
};

function parseFormat(request: Request): TestExportFormat | null {
  const value = new URL(request.url).searchParams.get('format');
  return value === 'csv' || value === 'json' || value === 'markdown' ? value : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  const format = parseFormat(request);
  if (!format) return new Response('Unsupported export format', { status: 400 });

  const context = await getTenantContext();
  const { testId } = await params;
  if (!(await canReadReportForTest(db, context, testId))) {
    return new Response('Forbidden', { status: 403 });
  }

  const source = await getTestExportSource(db, context.tenantId, testId);
  if (!source) return new Response('Not found', { status: 404 });

  const document = createTestExportDocument(source.metadata, source.measurements);
  const body = renderTestExport(document, format);
  const descriptor = formats[format];

  await auditTestArtifactDelivery(db, context.tenantId, testId, context, {
    kind: 'TEST_EXPORT',
    format,
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': descriptor.contentType,
      'Content-Disposition': `attachment; filename="test-${testId}.${descriptor.extension}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
