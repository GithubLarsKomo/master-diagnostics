import { authorize } from '@masters/domain';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { createDatabaseReportDeliveryService } from '@/lib/server/report-delivery-service';
import { getTenantContext } from '@/lib/tenant-context';

const inputSchema = z.object({ locale: z.enum(['de', 'en']) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  try {
    const context = await getTenantContext();
    authorize(context, 'test.run');
    const { testId } = await params;
    const { locale } = inputSchema.parse(await request.json());
    const generated = await createDatabaseReportDeliveryService(db)
      .generate(context.tenantId, testId, locale);
    return NextResponse.json(generated, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Report generation failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
