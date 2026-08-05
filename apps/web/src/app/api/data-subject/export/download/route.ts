import { db } from '@/lib/db';
import { createDataSubjectDeliveryPackageStorage } from '@/lib/data-subject-delivery-package-storage';
import { consumeDataSubjectDeliveryDownload } from '@/lib/server/data-subject-delivery-download';
import { serveDataSubjectDeliveryDownload } from '@/lib/server/data-subject-delivery-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return serveDataSubjectDeliveryDownload(request, {
    consume: (token) => consumeDataSubjectDeliveryDownload({
      db,
      packageStorage: createDataSubjectDeliveryPackageStorage(),
    }, token),
  });
}
