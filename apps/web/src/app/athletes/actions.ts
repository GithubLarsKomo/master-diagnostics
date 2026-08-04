'use server';

import { authorize } from '@masters/domain';
import { createAthlete, updateAthlete } from '@masters/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const athleteSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceCategory: z.string().trim().min(1).max(80),
  heightCm: z.coerce.number().int().min(80).max(250),
  weightKg: z.coerce.number().min(20).max(300),
  primarySport: z.string().trim().min(1).max(80),
  primaryDiscipline: z.string().trim().min(1).max(120),
  trainingStatus: z.string().trim().min(1).max(80),
});

function toAthleteInput(formData: FormData) {
  const input = athleteSchema.parse(Object.fromEntries(formData));
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    birthDate: input.birthDate,
    referenceCategory: input.referenceCategory,
    heightCm: input.heightCm,
    currentWeightKgX100: Math.round(input.weightKg * 100),
    primarySport: input.primarySport,
    primaryDiscipline: input.primaryDiscipline,
    trainingStatus: input.trainingStatus,
  };
}

export async function addAthlete(formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');

  await createAthlete(
    db,
    context.tenantId,
    {
      userId: context.userId,
      role: context.role,
      authProvider: context.authProvider,
      sessionId: context.sessionId,
    },
    toAthleteInput(formData),
  );

  revalidatePath('/athletes');
  redirect('/athletes');
}

export async function editAthlete(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');

  await updateAthlete(
    db,
    context.tenantId,
    athleteId,
    {
      userId: context.userId,
      role: context.role,
      authProvider: context.authProvider,
      sessionId: context.sessionId,
    },
    toAthleteInput(formData),
  );

  revalidatePath('/athletes');
  revalidatePath(`/athletes/${athleteId}`);
  redirect('/athletes');
}
