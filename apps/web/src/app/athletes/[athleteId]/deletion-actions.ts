'use server';

import { authorize } from '@masters/domain';
import { completeAthleteDeletion, decideAthleteDeletion, requestAthleteDeletion } from '@masters/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const reasonSchema = z.string().trim().min(3).max(1000);

export async function submitDeletionRequest(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const reason = reasonSchema.parse(formData.get('reason'));
  await requestAthleteDeletion(db, context.tenantId, athleteId, context, reason);
  revalidatePath(`/athletes/${athleteId}`);
}

export async function decideDeletionRequest(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const requestId = z.string().uuid().parse(formData.get('requestId'));
  const decision = z.enum(['APPROVED', 'REJECTED']).parse(formData.get('decision'));
  const reason = reasonSchema.parse(formData.get('reason'));
  await decideAthleteDeletion(db, context.tenantId, athleteId, requestId, context, decision, reason);
  revalidatePath(`/athletes/${athleteId}`);
}

export async function completeDeletionRequest(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const requestId = z.string().uuid().parse(formData.get('requestId'));
  const reason = reasonSchema.parse(formData.get('reason'));
  await completeAthleteDeletion(db, context.tenantId, athleteId, requestId, context, reason);
  redirect('/athletes');
}
