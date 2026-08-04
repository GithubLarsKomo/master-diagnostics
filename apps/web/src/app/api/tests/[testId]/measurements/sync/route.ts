import { authorize } from '@masters/domain';
import {
  syncTestMeasurement,
  type TestMeasurementSyncOperation,
} from '@masters/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('REST'), stageNumber: z.null() }),
  z.object({ kind: z.literal('STAGE'), stageNumber: z.number().int().min(1).max(12) }),
  z.object({ kind: z.literal('RECOVERY'), stageNumber: z.null() }),
]);

const operationSchema = z.object({
  operationId: z.string().uuid(),
  testId: z.string().uuid(),
  entityId: z.string().min(1).max(64),
  expectedVersion: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
  operationType: z.literal('TEST_MEASUREMENT_UPSERT'),
  schemaVersion: z.literal('1'),
  payload: z.object({
    target: targetSchema,
    lactateValueX100: z.number().int().min(50).max(3_000).nullable(),
    lactateQualifier: z.enum(['EXACT', 'LESS_THAN', 'GREATER_THAN']).nullable(),
    heartRate: z.number().int().min(20).max(250).nullable(),
    measuredAt: z.iso.datetime(),
  }),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  try {
    const context = await getTenantContext();
    authorize(context, 'test.run');
    const { testId } = await params;
    const operation = operationSchema.parse(await request.json());
    const lockToken = request.headers.get('x-test-lock-token');
    if (!lockToken) {
      return NextResponse.json(
        { error: 'Active test lock token is required' },
        { status: 409 },
      );
    }
    if (operation.testId !== testId) {
      return NextResponse.json(
        { error: 'Path and operation test IDs do not match' },
        { status: 400 },
      );
    }
    const result = await syncTestMeasurement(
      db,
      context.tenantId,
      context,
      operation as TestMeasurementSyncOperation,
      lockToken,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Measurement sync failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
