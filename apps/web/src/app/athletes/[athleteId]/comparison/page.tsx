import { authorize } from '@masters/domain';
import { getAthlete, getRecentAthleteLactateCurves } from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export default async function AthleteComparisonPage({ params }: { params: Promise<{ athleteId: string }> }) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const { athleteId } = await params;
  const athlete = await getAthlete(db, context.tenantId, athleteId);
  if (!athlete) notFound();

  const series = await getRecentAthleteLactateCurves(db, context.tenantId, athlete.id, 5);

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Athleten-Dashboard</p>
          <h1>Testvergleich</h1>
          <p>{athlete.firstName} {athlete.lastName}</p>
        </div>
        <Link href={`/athletes/${athlete.id}`}>Zurück zum Athleten</Link>
      </header>

      <section className="card" aria-labelledby="comparison-heading">
        <h2 id="comparison-heading">Bis zu fünf aktuelle Tests</h2>
        <p>Die Tests sind absteigend nach Testdatum sortiert. Jeder Test bleibt zusätzlich als vollständige Datentabelle lesbar.</p>
        {series.length === 0 ? (
          <p>Noch keine Tests für einen Vergleich vorhanden.</p>
        ) : (
          <>
            <table>
              <caption>Übersicht der verglichenen Tests</caption>
              <thead><tr><th scope="col">Test</th><th scope="col">Datum</th><th scope="col">Verwertbare Stufen</th><th scope="col">Leistungsbereich</th><th scope="col">Laktatbereich</th></tr></thead>
              <tbody>
                {series.map((test, index) => {
                  const watts = test.points.map((point) => point.watts);
                  const lactate = test.points.map((point) => point.lactateValueX100);
                  return (
                    <tr key={test.testId}>
                      <th scope="row">Test {index + 1}</th>
                      <td>{new Date(test.createdAt).toLocaleString('de-DE')}</td>
                      <td>{test.points.length}</td>
                      <td>{watts.length ? `${Math.min(...watts)}–${Math.max(...watts)} W` : '—'}</td>
                      <td>{lactate.length ? `${(Math.min(...lactate) / 100).toFixed(2)}–${(Math.max(...lactate) / 100).toFixed(2)} mmol/l` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {series.map((test, index) => (
              <section key={test.testId} className="card" aria-labelledby={`comparison-test-${index + 1}`}>
                <h3 id={`comparison-test-${index + 1}`}>Test {index + 1} · {new Date(test.createdAt).toLocaleString('de-DE')}</h3>
                {test.points.length === 0 ? (
                  <p>Keine verwertbaren Laktat-Stufenmessungen.</p>
                ) : (
                  <table>
                    <caption>Messwerte Test {index + 1}</caption>
                    <thead><tr><th scope="col">Stufe</th><th scope="col">Leistung</th><th scope="col">Laktat</th><th scope="col">Qualifier</th></tr></thead>
                    <tbody>{test.points.map((point) => (
                      <tr key={point.stageNumber}>
                        <th scope="row">{point.stageNumber}</th>
                        <td>{point.watts} W</td>
                        <td>{(point.lactateValueX100 / 100).toFixed(2)} mmol/l</td>
                        <td>{point.qualifier}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
                <p><Link href={`/tests/${test.testId}`}>Test öffnen</Link></p>
              </section>
            ))}
          </>
        )}
      </section>
    </main>
  );
}
