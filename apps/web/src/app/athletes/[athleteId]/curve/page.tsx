import { authorize } from '@masters/domain';
import { getAthlete, getLatestAthleteLactateCurve } from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

const width = 640;
const height = 320;
const padding = 48;

export default async function AthleteLactateCurvePage({ params }: { params: Promise<{ athleteId: string }> }) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const { athleteId } = await params;
  const athlete = await getAthlete(db, context.tenantId, athleteId);
  if (!athlete) notFound();

  const points = await getLatestAthleteLactateCurve(db, context.tenantId, athlete.id);
  const minWatts = points.length > 0 ? Math.min(...points.map((point) => point.watts)) : 0;
  const maxWatts = points.length > 0 ? Math.max(...points.map((point) => point.watts)) : 1;
  const maxLactate = points.length > 0 ? Math.max(100, ...points.map((point) => point.lactateValueX100)) : 100;
  const xRange = Math.max(1, maxWatts - minWatts);
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const coordinates = points.map((point) => ({
    ...point,
    x: padding + ((point.watts - minWatts) / xRange) * plotWidth,
    y: height - padding - (point.lactateValueX100 / maxLactate) * plotHeight,
  }));
  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(' ');

  return (
    <main>
      <header className="app-header">
        <div><p className="eyebrow">Athleten-Dashboard</p><h1>Laktatkurve</h1><p>{athlete.firstName} {athlete.lastName}</p></div>
        <Link href={`/athletes/${athlete.id}`}>Zurück zum Athleten</Link>
      </header>

      <section className="card" aria-labelledby="lactate-curve-heading">
        <h2 id="lactate-curve-heading">Aktuellster Test</h2>
        {points.length < 2 ? (
          <p>Für eine Kurve sind mindestens zwei verwertbare Stufenmessungen erforderlich.</p>
        ) : (
          <>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="curve-title curve-desc" style={{ width: '100%', maxWidth: width }}>
              <title id="curve-title">Laktat-Leistungs-Kurve des aktuellsten Tests</title>
              <desc id="curve-desc">Laktatwerte in Millimol pro Liter über der Leistung in Watt. Die exakten Werte stehen zusätzlich in der Tabelle unterhalb der Grafik.</desc>
              <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="currentColor" />
              <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="currentColor" />
              <polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="3" />
              {coordinates.map((point) => <circle key={point.stageNumber} cx={point.x} cy={point.y} r="5"><title>{`Stufe ${point.stageNumber}: ${point.watts} Watt, ${(point.lactateValueX100 / 100).toFixed(2)} mmol/l`}</title></circle>)}
              <text x={width / 2} y={height - 8} textAnchor="middle">Leistung (W)</text>
              <text x="16" y={height / 2} textAnchor="middle" transform={`rotate(-90 16 ${height / 2})`}>Laktat (mmol/l)</text>
            </svg>

            <table>
              <caption>Messwerte der Laktatkurve</caption>
              <thead><tr><th scope="col">Stufe</th><th scope="col">Leistung</th><th scope="col">Laktat</th><th scope="col">Qualifier</th></tr></thead>
              <tbody>{points.map((point) => <tr key={point.stageNumber}><th scope="row">{point.stageNumber}</th><td>{point.watts} W</td><td>{(point.lactateValueX100 / 100).toFixed(2)} mmol/l</td><td>{point.qualifier}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}
