import { isClubConfigured } from '@masters/db';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { completeSetup } from './actions';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (process.env.DEPLOYMENT_MODE !== 'club') redirect('/');
  if (await isClubConfigured(db)) redirect('/');

  return <main>
    <h1>Club einrichten</h1>
    <p>Dieser Assistent legt den einzigen Tenant und den ersten Tenant-Admin an.</p>
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
  </main>;
}
