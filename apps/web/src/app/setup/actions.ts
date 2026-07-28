'use server';

import {
  bootstrapClub,
  isClubConfigured,
  removeAuthUser,
} from '@masters/db';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

const setupSchema = z.object({
  clubName: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  timezone: z.string().trim().min(1),
  locale: z.enum(['de', 'en']),
  retentionYears: z.coerce
    .number()
    .int()
    .min(1)
    .max(10),
  adminName: z.string().trim().min(2).max(120),
  adminEmail: z.string().trim().email(),
  password: z.string().min(12).max(128),
});

export async function completeSetup(formData: FormData) {
  if (process.env.DEPLOYMENT_MODE !== 'club') {
    throw new Error(
      'Setup wizard is only available in club mode',
    );
  }

  if (await isClubConfigured(db)) {
    redirect('/');
  }

  const input = setupSchema.parse(
    Object.fromEntries(formData),
  );

  const signUp = await auth.api.signUpEmail({
    body: {
      name: input.adminName,
      email: input.adminEmail,
      password: input.password,
    },
  });

  const authUserId = signUp.user?.id;

  if (!authUserId) {
    throw new Error(
      'Unable to create local administrator',
    );
  }

  try {
    await bootstrapClub(db, {
      clubName: input.clubName,
      slug: input.slug,
      timezone: input.timezone,
      locale: input.locale,
      retentionYears: input.retentionYears,
      admin: {
        authUserId,
        email: input.adminEmail,
        displayName: input.adminName,
      },
    });
  } catch (error) {
    try {
      await removeAuthUser(db, authUserId);
    } catch (cleanupError) {
      console.error(
        'Failed to remove orphaned authentication user',
        {
          authUserId,
          cleanupError,
        },
      );
    }

    throw error;
  }

  redirect('/');
}