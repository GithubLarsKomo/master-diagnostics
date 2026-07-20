'use server';

import { bootstrapClub, isClubConfigured } from '@masters/db';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

const setupSchema = z.object({
  clubName: z.string().trim().min(2).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  timezone: z.string().trim().min(1),
  locale: z.enum(['de', 'en']),
  retentionYears: z.coerce.number().int().min(1).max(10),
  adminName: z.string().trim().min(2).max(120),
  adminEmail: z.string().trim().email(),
  password: z.string().min(12).max(128),
});

export async function completeSetup(formData: FormData) {
  if (process.env.DEPLOYMENT_MODE !== 'club') throw new Error('Setup wizard is only available in club mode');
  if (await isClubConfigured(db)) redirect('/');
  const input = setupSchema.parse(Object.fromEntries(formData));

  const signUp = await auth.api.signUpEmail({ body: { name: input.adminName, email: input.adminEmail, password: input.password } });
  if (!signUp.user?.id) throw new Error('Unable to create local administrator');

  try {
    await bootstrapClub(db, {
      clubName: input.clubName, slug: input.slug, timezone: input.timezone, locale: input.locale,
      retentionYears: input.retentionYears,
      admin: { authUserId: signUp.user.id, email: input.adminEmail, displayName: input.adminName },
    });
  } catch (error) {
    // Better Auth owns the credential record. A failed domain bootstrap is surfaced for administrative recovery.
    throw error;
  }
  redirect('/');
}
