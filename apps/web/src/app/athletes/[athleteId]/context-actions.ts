'use server';

import { authorize } from '@masters/domain';
import { assignCoach, createAthleteSnapshot } from '@masters/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const assignmentSchema = z.object({
  coachUserId: z.string().uuid(),
  isPrimary: z.string().optional(),
});

export async function addCoachAssignment(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const input = assignmentSchema.parse(Object.fromEntries(formData));
  await assignCoach(
    db,
    context.tenantId,
    athleteId,
    input.coachUserId,
    input.isPrimary === 'on',
    { userId: context.userId, role: context.role },
  );
  revalidatePath(`/athletes/${athleteId}`);
}

export async function captureAthleteSnapshot(athleteId: string) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  await createAthleteSnapshot(
    db,
    context.tenantId,
    athleteId,
    { userId: context.userId, role: context.role },
  );
  revalidatePath(`/athletes/${athleteId}`);
}
