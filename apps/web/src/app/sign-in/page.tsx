import { isClubConfigured } from '@masters/db';
import { redirect } from 'next/navigation';
import { BrandLockup } from '@/components/brand-lockup';
import { db } from '@/lib/db';
import { SignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (process.env.DEPLOYMENT_MODE === 'club' && !(await isClubConfigured(db))) redirect('/setup');
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="sign-in-heading">
        <BrandLockup />
        <div className="auth-intro">
          <p className="eyebrow">Sport Performance Diagnostics</p>
          <h1 id="sign-in-heading">Anmelden</h1>
          <p>Leistungsdiagnostik, Teststeuerung und Auswertung in einem trainerzentrierten Arbeitsbereich.</p>
        </div>
        <SignInForm />
      </section>
    </main>
  );
}
