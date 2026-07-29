'use server';

import { authorize } from '@masters/domain';
import { registerGuardian, revokeGuardian, type GuardianInput } from '@masters/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

const guardianSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  relationship: z.string().trim().min(2).max(80),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(60).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
});

export async function addGuardian(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const parsed = guardianSchema.parse(Object.fromEntries(formData));
  const input: GuardianInput = {
    fullName: parsed.fullName,
    relationship: parsed.relationship,
  };
  if (parsed.email) input.email = parsed.email;
  if (parsed.phone) input.phone = parsed.phone;
  if (parsed.validUntil) input.validUntil = parsed.validUntil;

  await registerGuardian(
    db,
    context.tenantId,
    athleteId,
    { userId: context.userId, role: context.role },
    input,
  );
  revalidatePath(`/athletes/${athleteId}`);
}

export async function removeGuardian(athleteId: string, formData: FormData) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const guardianId = z.string().uuid().parse(formData.get('guardianId'));
  const reason = z.string().trim().min(3).max(500).parse(formData.get('reason'));
  await revokeGuardian(db, context.tenantId, athleteId, guardianId, { userId: context.userId, role: context.role }, reason);
  revalidatePath(`/athletes/${athleteId}`);
}
