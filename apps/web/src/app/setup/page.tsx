import { isClubConfigured } from '@masters/db';
import { redirect } from 'next/navigation';
import { BrandLockup } from '@/components/brand-lockup';
import { db } from '@/lib/db';
import { completeSetup } from './actions';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (process.env.DEPLOYMENT_MODE !== 'club') redirect('/');
  if (await isClubConfigured(db)) redirect('/');

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="setup-heading">
        <BrandLockup />
        <div className="auth-intro">
          <p className="eyebrow">Ersteinrichtung</p>
          <h1 id="setup-heading">Club einrichten</h1>
          <p>Lege den Club und den ersten Tenant-Admin für Masters Diagnostics an.</p>
        </div>
        <form action={completeSetup} className="card setup-form">
          <label>Clubname<input required name="clubName" autoComplete="organization" /></label>
          <label>Slug<input required name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="mein-ruderclub" /></label>
          <label>Zeitzone<input required name="timezone" defaultValue="Europe/Berlin" /></label>
          <label>Sprache<select name="locale" defaultValue="de"><option value="de">Deutsch</option><option value="en">English</option></select></label>
          <label>Aufbewahrung (Jahre)<input required name="retentionYears" type="number" min="1" max="10" defaultValue="10" /></label>
          <h2>Erster Tenant-Admin</h2>
          <label>Name<input required name="adminName" autoComplete="name" /></label>
          <label>E-Mail<input required name="adminEmail" type="email" autoComplete="email" /></label>
          <label>Passwort<input required name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" /></label>
          <button type="submit">Installation abschließen</button>
        </form>
      </section>
    </main>
  );
}
