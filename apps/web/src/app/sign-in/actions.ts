'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';

const schema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });

export async function signIn(formData: FormData) {
  const input = schema.parse(Object.fromEntries(formData));
  const result = await auth.api.signInEmail({ body: { ...input, rememberMe: true } });
  if (!result.user) throw new Error('Anmeldung fehlgeschlagen');
  redirect('/');
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect('/sign-in');
}
