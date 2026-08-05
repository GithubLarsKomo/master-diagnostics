import { authorize } from '@masters/domain';
import {
  acquireTestLock,
  releaseTestLock,
  renewTestLock,
  takeOverTestLock,
} from '@masters/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('acquire') }),
  z.object({ action: z.literal('renew'), token: z.string().min(32).max(256) }),
  z.object({
    action: z.literal('takeover'),
    reason: z.string().trim().min(5).max(500),
  }),
  z.object({ action: z.literal('release'), token: z.string().min(32).max(256) }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  try {
    const context = await getTenantContext();
    authorize(context, 'test.run');
    const { testId } = await params;
    const input = requestSchema.parse(await request.json());

    if (input.action === 'acquire') {
      const result = await acquireTestLock(
        db,
        context.tenantId,
        context,
        testId,
      );
      return NextResponse.json(result, {
        status: result.status === 'ACQUIRED' ? 200 : 409,
      });
    }
    if (input.action === 'renew') {
      return NextResponse.json(await renewTestLock(
        db,
        context.tenantId,
        context,
        testId,
        input.token,
      ));
    }
    if (input.action === 'takeover') {
      return NextResponse.json(await takeOverTestLock(
        db,
        context.tenantId,
        context,
        testId,
        input.reason,
      ));
    }

    await releaseTestLock(
      db,
      context.tenantId,
      context,
      testId,
      input.token,
    );
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test lock action failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
