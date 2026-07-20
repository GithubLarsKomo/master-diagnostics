import { planFromExpectedLt2 } from '@masters/diagnostics';

export default function HomePage() {
  const example = planFromExpectedLt2(350, 8);
  return (
    <main>
      <h1>Masters Diagnostics</h1>
      <p>GitHub-fähiges Grundgerüst für den Diagnostik-MVP.</p>
      <section className="grid" aria-label="Projektstatus">
        <article className="card"><h2>Betriebsarten</h2><p>Autarker Club-Modus und Multi-Tenant-SaaS.</p></article>
        <article className="card"><h2>Fachkern</h2><p>Versionierte Schwellen- und Zonenmodelle.</p></article>
        <article className="card"><h2>Offline</h2><p>IndexedDB und idempotente Synchronisation.</p></article>
      </section>
      <section className="card">
        <h2>Beispielplanung bei erwarteter LT2 von 350 W</h2>
        <p>Start: {example.startWatts} W · Inkrement: {example.incrementWatts} W</p>
        <ol>{example.stages.map((watts) => <li key={watts}>{watts} W</li>)}</ol>
      </section>
      <p>Siehe <code>SPEC.md</code>, <code>ARCHITECTURE.md</code> und <code>TASKS.md</code>.</p>
    </main>
  );
}
