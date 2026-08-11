'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';

const schema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });

export type SignInState = {
  error: string | null;
};

export async function signIn(_previousState: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: 'Bitte eine gültige E-Mail-Adresse und ein Passwort eingeben.' };
  }

  try {
    const result = await auth.api.signInEmail({ body: { ...parsed.data, rememberMe: true } });
    if (!result.user) return { error: 'E-Mail-Adresse oder Passwort ist falsch.' };
  } catch {
    return { error: 'E-Mail-Adresse oder Passwort ist falsch.' };
  }

  redirect('/');
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect('/sign-in');
}
