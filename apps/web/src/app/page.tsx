import { planFromExpectedLt2 } from '@masters/diagnostics';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getTenantContext } from '@/lib/tenant-context';
import { signOut } from './sign-in/actions';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const tenantContext = await getTenantContext();
  const example = planFromExpectedLt2(350, 8);
  return (
    <main>
      <header className="app-header">
        <div><h1>Masters Diagnostics</h1><p>{session?.user.name} · {tenantContext.role}</p></div>
        <form action={signOut}><button type="submit">Abmelden</button></form>
      </header>
      <section className="grid" aria-label="Projektstatus">
        <article className="card"><h2>Club eingerichtet</h2><p>Single-Tenant-Betrieb mit lokalem Better Auth und libSQL.</p></article>
        <article className="card"><h2>Tenant-Kontext</h2><p>Anfragen werden serverseitig dem aktiven Tenant und Benutzer zugeordnet.</p></article>
        <article className="card"><h2>Rollenmodell</h2><p>Berechtigungen und Tenant-Isolation werden gemeinsam geprüft.</p></article>
      </section>
      <section className="card">
        <h2>Beispielplanung bei erwarteter LT2 von 350 W</h2>
        <p>Start: {example.startWatts} W · Inkrement: {example.incrementWatts} W</p>
        <ol>{example.stages.map((watts) => <li key={watts}>{watts} W</li>)}</ol>
      </section>
    </main>
  );
}
