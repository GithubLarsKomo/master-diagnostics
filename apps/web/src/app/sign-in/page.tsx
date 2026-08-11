import { isClubConfigured } from '@masters/db';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { SignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (process.env.DEPLOYMENT_MODE === 'club' && !(await isClubConfigured(db))) redirect('/setup');
  return <main>
    <h1>Anmelden</h1>
    <SignInForm />
  </main>;
}
