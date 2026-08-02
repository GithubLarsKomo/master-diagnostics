import { canReadReportForTest, getReportVersion } from '@masters/db';
import { db } from '@/lib/db';
import { createReportArtifactStorage } from '@/lib/report-artifact-storage';
import { readVerifiedReportArtifact } from '@/lib/report-artifact-service';
import { getTenantContext } from '@/lib/tenant-context';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ testId: string; reportVersionId: string }> },
) {
  try {
    const context = await getTenantContext();
    const { testId, reportVersionId } = await params;
    const version = await getReportVersion(db, context.tenantId, testId, reportVersionId);

    if (!version) {
      return Response.json({ error: 'Report version not found' }, { status: 404 });
    }

    if (!(await canReadReportForTest(db, context, testId))) {
      return Response.json({ error: 'Report access denied' }, { status: 403 });
    }

    const bytes = await readVerifiedReportArtifact(createReportArtifactStorage(), version);
    const body = Uint8Array.from(bytes).buffer;
    const filename = `masters-report-${version.locale}-v${version.versionNumber}.pdf`;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Report-Content-Hash': version.contentHash,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Report download failed';
    return Response.json({ error: message }, { status: 400 });
  }
}
