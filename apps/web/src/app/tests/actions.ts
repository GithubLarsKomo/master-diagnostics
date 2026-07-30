'use server';

import {
  TEST_START_SAFETY_CHECKLIST_ITEMS,
  authorize,
  type TestStartSafetyChecklistConfirmation,
  type TestTerminationReason,
} from '@masters/domain';
import {
  confirmTestSafetyChecklist,
  createTestPlanSnapshot,
  finishTest,
  startTest,
} from '@masters/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const planSchema = z.object({
  athleteId: z.string().uuid(),
  protocolVersionId: z.string().uuid(),
  expectedLt2Watts: z.coerce.number().min(25).max(2000),
  stageCount: z.coerce.number().int().min(5).max(8),
  startPowerWatts: z.union([z.literal(''), z.coerce.number().min(5).max(2000)]),
  incrementWatts: z.union([z.literal(''), z.coerce.number().min(5).max(2000)]),
});

const terminationReasons = [
  'REGULAR_EXHAUSTION',
  'VOLUNTARY_STOP',
  'TECHNICAL_FAILURE',
  'PAIN_OR_DISCOMFORT',
  'ABNORMAL_HEART_RATE',
  'PROTOCOL_ERROR',
  'OTHER',
] as const;

const finishSchema = z.object({
  reason: z.enum(terminationReasons),
  notes: z.string().max(2000).optional(),
  lockToken: z.string().min(32).max(256),
});

function actor(context: Awaited<ReturnType<typeof getTenantContext>>) {
  return { userId: context.userId, role: context.role };
}

export async function planTest(formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'test.plan');
  const input = planSchema.parse(Object.fromEntries(formData));
  const created = await createTestPlanSnapshot(db, context.tenantId, actor(context), {
    athleteId: input.athleteId,
    protocolVersionId: input.protocolVersionId,
    expectedLt2Watts: input.expectedLt2Watts,
    stageCount: input.stageCount,
    ...(input.startPowerWatts === '' ? {} : { startPowerWatts: input.startPowerWatts }),
    ...(input.incrementWatts === '' ? {} : { incrementWatts: input.incrementWatts }),
  });
  redirect(`/tests/${created.test.id}`);
}

export async function confirmSafety(testId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  const confirmation = Object.fromEntries(
    TEST_START_SAFETY_CHECKLIST_ITEMS.map((item) => [item, formData.get(item) === 'on']),
  ) as TestStartSafetyChecklistConfirmation;
  await confirmTestSafetyChecklist(
    db,
    context.tenantId,
    actor(context),
    testId,
    confirmation,
  );
  revalidatePath(`/tests/${testId}`);
}

export async function startPlannedTest(testId: string) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  await startTest(db, context.tenantId, actor(context), testId);
  revalidatePath('/tests');
  revalidatePath(`/tests/${testId}`);
}

export async function finishRunningTest(testId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  const input = finishSchema.parse(Object.fromEntries(formData));
  await finishTest(db, context.tenantId, actor(context), testId, {
    reason: input.reason as TestTerminationReason,
    lockToken: input.lockToken,
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  });
  revalidatePath('/tests');
  revalidatePath(`/tests/${testId}`);
}
