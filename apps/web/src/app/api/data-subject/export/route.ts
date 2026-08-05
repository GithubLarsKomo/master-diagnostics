import { headers } from 'next/headers';
import { validateAthleteDataSubjectDeliveryApproval } from '@masters/db';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { createDataSubjectDeliveryPackageStorage } from '@/lib/data-subject-delivery-package-storage';
import { createReportArtifactStorage } from '@/lib/report-artifact-storage';
import { getTenantContext } from '@/lib/tenant-context';
import { serveDataSubjectDeliveryPackageCreation } from '@/lib/server/data-subject-delivery-admin-http';
import { createDataSubjectDeliveryPackage } from '@/lib/server/data-subject-delivery-package-writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthenticated(): Response {
  return Response.json({ error: 'DATA_SUBJECT_EXPORT_AUTHENTICATION_REQUIRED' }, {
    status: 401,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let context;
  try {
    context = await getTenantContext();
  } catch {
    return unauthenticated();
  }

  return serveDataSubjectDeliveryPackageCreation(request, context, {
    verifyPassword: async (password) => {
      try {
        await auth.api.verifyPassword({
          body: { password },
          headers: await headers(),
        });
        return true;
      } catch {
        return false;
      }
    },
    validateApproval: (tenantId, athleteId, approvalId) => validateAthleteDataSubjectDeliveryApproval(
      db,
      tenantId,
      athleteId,
      approvalId,
    ),
    createPackage: (input) => createDataSubjectDeliveryPackage({
      db,
      reportStorage: createReportArtifactStorage(),
      packageStorage: createDataSubjectDeliveryPackageStorage(),
    }, input),
  });
}
