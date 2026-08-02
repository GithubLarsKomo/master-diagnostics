'use client';

import { useState } from 'react';

type Locale = 'de' | 'en';

export function ReportDeliveryControls({ testId }: { testId: string }) {
  const [locale, setLocale] = useState<Locale>('de');
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    setDownloadPath(null);
    try {
      const response = await fetch(`/api/tests/${testId}/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      const payload = await response.json() as { downloadPath?: string; error?: string };
      if (!response.ok || !payload.downloadPath) {
        throw new Error(payload.error ?? 'Bericht konnte nicht erzeugt werden');
      }
      setDownloadPath(payload.downloadPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Bericht konnte nicht erzeugt werden');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="report-delivery-heading">
      <h2 id="report-delivery-heading">Bericht</h2>
      <p>Erzeuge eine unveränderliche PDF-Berichtsversion aus der freigegebenen Interpretation.</p>
      <label>
        Sprache
        <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          <option value="de">Deutsch</option>
          <option value="en">English</option>
        </select>
      </label>
      <button type="button" onClick={generate} disabled={busy}>
        {busy ? 'Bericht wird erzeugt …' : 'PDF-Bericht erzeugen'}
      </button>
      {error && <p role="alert">{error}</p>}
      {downloadPath && (
        <p role="status">
          Bericht gespeichert. <a href={downloadPath}>PDF herunterladen</a>
        </p>
      )}
    </section>
  );
}
