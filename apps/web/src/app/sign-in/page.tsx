import { isClubConfigured } from '@masters/db';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { signIn } from './actions';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (process.env.DEPLOYMENT_MODE === 'club' && !(await isClubConfigured(db))) redirect('/setup');
  return <main>
    <h1>Anmelden</h1>
    <form action={signIn} className="card setup-form">
      <label>E-Mail<input required name="email" type="email" autoComplete="email" /></label>
      <label>Passwort<input required name="password" type="password" autoComplete="current-password" /></label>
      <button type="submit">Anmelden</button>
    </form>
  </main>;
}
