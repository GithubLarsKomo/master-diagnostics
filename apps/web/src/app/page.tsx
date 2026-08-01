import {
  deriveTrainerDashboardSummary,
  deriveTrainerDashboardTasks,
} from '@masters/domain';
import { planFromExpectedLt2 } from '@masters/diagnostics';
import { listTestsForTrainerDashboard } from '@masters/db';
import type { Route } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { signOut } from './sign-in/actions';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const tenantContext = await getTenantContext();
  const example = planFromExpectedLt2(350, 8);
  const dashboardRows = tenantContext.role === 'TRAINER' || tenantContext.role === 'TENANT_ADMIN'
    ? await listTestsForTrainerDashboard(db, tenantContext.tenantId, {
        userId: tenantContext.userId,
        role: tenantContext.role,
      })
    : [];
  const dashboardTasks = deriveTrainerDashboardTasks(dashboardRows.map(({ test, athlete }) => ({
    testId: test.id,
    athleteName: `${athlete.firstName} ${athlete.lastName}`,
    status: test.status,
  })));
  const dashboardSummary = deriveTrainerDashboardSummary(dashboardTasks);

  return (
    <main>
      <header className="app-header">
        <div><h1>Masters Diagnostics</h1><p>{session?.user.name} · {tenantContext.role}</p></div>
        <form action={signOut}><button type="submit">Abmelden</button></form>
      </header>

      {(tenantContext.role === 'TRAINER' || tenantContext.role === 'TENANT_ADMIN') && (
        <section className="card" aria-labelledby="trainer-tasks-heading">
          <p className="eyebrow">Trainer-Dashboard</p>
          <h2 id="trainer-tasks-heading">Meine nächsten Aufgaben</h2>
          <dl aria-label="Aufgabenübersicht">
            <div><dt>Offen gesamt</dt><dd>{dashboardSummary.total}</dd></div>
            <div><dt>Laufende Tests</dt><dd>{dashboardSummary.continueTests}</dd></div>
            <div><dt>Datenprüfung</dt><dd>{dashboardSummary.reviewData}</dd></div>
            <div><dt>Vorbereitung</dt><dd>{dashboardSummary.prepareTests}</dd></div>
          </dl>
          {dashboardTasks.length === 0 ? (
            <p>Aktuell gibt es keine offenen Testaufgaben.</p>
          ) : (
            <ol>
              {dashboardTasks.map((task) => (
                <li key={task.testId}>
                  <strong>{task.athleteName}</strong> · {task.label} · <Link href={task.href as Route}>Öffnen</Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <section className="grid" aria-label="Arbeitsbereiche">
        <article className="card"><h2>Athleten</h2><p>Tenant-gebundene Stammdaten anlegen und verwalten.</p><Link href="/athletes">Athleten öffnen</Link></article>
        <article className="card"><h2>Tests</h2><p>Stufentests planen, vorbereiten und live durchführen.</p><Link href="/tests">Tests öffnen</Link></article>
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
