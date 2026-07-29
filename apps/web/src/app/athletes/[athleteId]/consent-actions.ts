'use server';

import { authorize } from '@masters/domain';
import { grantConsent, withdrawConsent } from '@masters/db';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

export async function addConsent(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const consentType = String(formData.get('consentType') ?? '').trim();
  const documentVersion = String(formData.get('documentVersion') ?? '').trim();
  await grantConsent(db, context.tenantId, athleteId, { userId: context.userId, role: context.role }, consentType, documentVersion);
  revalidatePath(`/athletes/${athleteId}`);
}

export async function withdrawAthleteConsent(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const consentId = String(formData.get('consentId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  await withdrawConsent(db, context.tenantId, athleteId, consentId, { userId: context.userId, role: context.role }, reason);
  revalidatePath(`/athletes/${athleteId}`);
}
