import {
  assessReidentificationRisk,
  createAnonymizedAnalysisExport,
  createTestExportDocument,
  renderAnonymizedAnalysisExportJson,
} from '@masters/domain';
import {
  canReadReportForTest,
  getAnalysisExportCohortEvidence,
  getTestExportSource,
} from '@masters/db';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

function readMinimumEquivalenceClassSize(): number | null {
  const raw = process.env.ANALYSIS_EXPORT_MIN_EQUIVALENCE_CLASS_SIZE;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 2 ? value : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  const context = await getTenantContext();
  const { testId } = await params;
  if (!(await canReadReportForTest(db, context, testId))) {
    return new Response('Forbidden', { status: 403 });
  }

  const minimumEquivalenceClassSize = readMinimumEquivalenceClassSize();
  if (minimumEquivalenceClassSize === null) {
    return Response.json({
      error: 'ANALYSIS_EXPORT_POLICY_NOT_CONFIGURED',
      message: 'Analysis export is disabled until a valid minimum equivalence class size is configured.',
    }, { status: 503 });
  }

  const [source, cohort] = await Promise.all([
    getTestExportSource(db, context.tenantId, testId),
    getAnalysisExportCohortEvidence(db, context.tenantId, testId),
  ]);
  if (!source) return new Response('Not found', { status: 404 });
  if (!cohort || source.metadata.status !== 'RELEASED') {
    return Response.json({
      error: 'ANALYSIS_EXPORT_REQUIRES_RELEASED_TEST',
    }, { status: 409 });
  }

  const assessment = assessReidentificationRisk(
    { equivalenceClassSize: cohort.equivalenceClassSize },
    { minimumEquivalenceClassSize },
  );
  if (!assessment.exportAllowed) {
    return Response.json({
      error: 'REIDENTIFICATION_RISK_WARNING',
      assessment,
      cohort: {
        testYear: cohort.testYear,
        deviceType: cohort.deviceType,
        protocolVersion: cohort.protocolVersion,
      },
    }, {
      status: 409,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Reidentification-Risk': assessment.level,
      },
    });
  }

  const regular = createTestExportDocument(source.metadata, source.measurements);
  const anonymized = createAnonymizedAnalysisExport(regular);
  const body = renderAnonymizedAnalysisExportJson(anonymized);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="analysis-${cohort.testYear}-${cohort.deviceType.toLowerCase()}.json"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Reidentification-Risk': assessment.level,
      'X-Equivalence-Class-Size': String(assessment.equivalenceClassSize),
    },
  });
}
