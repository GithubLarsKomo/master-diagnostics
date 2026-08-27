import { authorize } from '@masters/domain';
import { listAthletes } from '@masters/db';
import Link from 'next/link';
import { BrandLockup } from '@/components/brand-lockup';
import { WorkspaceNav } from '@/components/workspace-nav';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { addAthlete } from './actions';
import { AthleteSportFields } from './athlete-sport-fields';

export const dynamic = 'force-dynamic';

export default async function AthletesPage() {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const athleteRows = await listAthletes(db, context.tenantId);

  return (
    <main>
      <header className="app-header">
        <div>
          <BrandLockup compact />
          <p className="eyebrow">Athletenmanagement</p>
          <h1>Athleten</h1>
          <p>Tenant-gebundene Stammdaten und Trainingskontext für diagnostische Tests.</p>
        </div>
        <Link className="secondary-action" href="/">Zur Übersicht</Link>
      </header>

      <WorkspaceNav />

      <section className="grid" aria-label="Athletenbestand">
        {athleteRows.length === 0 ? (
          <article className="card info-card"><h2>Noch keine Athleten</h2><p>Lege den ersten Athleten über das Formular an.</p></article>
        ) : athleteRows.map((athlete) => (
          <article className="card entity-card" key={athlete.id}>
            <p className="eyebrow">{athlete.referenceCategory}</p>
            <h2>{athlete.firstName} {athlete.lastName}</h2>
            <p>{athlete.primarySport} · {athlete.primaryDiscipline}</p>
            <p>{athlete.heightCm} cm · {(athlete.currentWeightKgX100 / 100).toLocaleString('de-DE')} kg</p>
            <p>Trainingsstatus: {athlete.trainingStatus}</p>
            <Link className="card-action" href={`/athletes/${athlete.id}`}>Bearbeiten</Link>
          </article>
        ))}
      </section>

      <section className="card planning-card">
        <p className="eyebrow">Neues Profil</p>
        <h2>Athlet anlegen</h2>
        <p className="muted">Erfasse nur die für Training und Diagnostik erforderlichen Stammdaten.</p>
        <form action={addAthlete} className="setup-form">
          <label>Vorname<input name="firstName" required maxLength={120} /></label>
          <label>Nachname<input name="lastName" required maxLength={120} /></label>
          <label>Geburtsdatum<input name="birthDate" type="date" required /></label>
          <label>Referenzkategorie<input name="referenceCategory" required placeholder="Masters A" /></label>
          <label>Körpergröße (cm)<input name="heightCm" type="number" min="80" max="250" required /></label>
          <label>Gewicht (kg)<input name="weightKg" type="number" min="20" max="300" step="0.01" required /></label>
          <AthleteSportFields />
          <button type="submit">Athlet speichern</button>
        </form>
      </section>
    </main>
  );
}
