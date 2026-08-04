import { authorize } from '@masters/domain';
import {
  correctTestMeasurement,
  type CorrectTestMeasurementInput,
} from '@masters/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const qualityStatusSchema = z.enum([
  'VALID',
  'PARTIAL',
  'EXCLUDED',
  'MISSING',
  'MANUALLY_CORRECTED',
]);

const correctionSchema = z.object({
  kind: z.enum(['REST', 'STAGE', 'RECOVERY']),
  stageNumber: z.number().int().min(1).max(12).nullable(),
  expectedVersion: z.number().int().nonnegative(),
  heartRate: z.number().int().min(20).max(250).nullable(),
  lactateValueX100: z.number().int().min(50).max(3_000).nullable(),
  lactateQualifier: z.enum(['EXACT', 'LESS_THAN', 'GREATER_THAN']).nullable(),
  measuredAt: z.iso.datetime().nullable(),
  qualityStatus: qualityStatusSchema.nullable(),
  notes: z.string().max(2_000).nullable(),
  reason: z.string().trim().min(5).max(500),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  try {
    const context = await getTenantContext();
    authorize(context, 'test.run');
    const { testId } = await params;
    const input = correctionSchema.parse(await request.json());
    const result = await correctTestMeasurement(
      db,
      context.tenantId,
      context,
      testId,
      input as CorrectTestMeasurementInput,
    );
    return NextResponse.json(result, {
      status: result.status === 'CONFLICT' ? 409 : 200,
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'Measurement correction failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
