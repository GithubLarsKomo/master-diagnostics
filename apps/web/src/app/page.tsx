import { resolveMembership } from '@masters/db';
import { planFromExpectedLt2 } from '@masters/diagnostics';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { signOut } from './sign-in/actions';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const membership = session ? await resolveMembership(db, session.user.id) : null;
  const example = planFromExpectedLt2(350, 8);
  return (
    <main>
      <header className="app-header">
        <div><h1>Masters Diagnostics</h1><p>{session?.user.name} · {membership?.role ?? 'ohne Fachrolle'}</p></div>
        <form action={signOut}><button type="submit">Abmelden</button></form>
      </header>
      <section className="grid" aria-label="Projektstatus">
        <article className="card"><h2>Club eingerichtet</h2><p>Single-Tenant-Betrieb mit lokalem Better Auth und libSQL.</p></article>
        <article className="card"><h2>Rollenmodell</h2><p>Erster Benutzer ist Tenant-Admin; Berechtigungen liegen im Fachmodell.</p></article>
        <article className="card"><h2>Audit</h2><p>Die Einrichtung wird transaktional und nachvollziehbar protokolliert.</p></article>
      </section>
      <section className="card">
        <h2>Beispielplanung bei erwarteter LT2 von 350 W</h2>
        <p>Start: {example.startWatts} W · Inkrement: {example.incrementWatts} W</p>
        <ol>{example.stages.map((watts) => <li key={watts}>{watts} W</li>)}</ol>
      </section>
    </main>
  );
}
