import { authorize } from '@masters/domain';
import { getAthlete } from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { editAthlete } from '../actions';

export const dynamic = 'force-dynamic';

export default async function AthletePage({
  params,
}: {
  params: Promise<{ athleteId: string }>;
}) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const { athleteId } = await params;
  const athlete = await getAthlete(db, context.tenantId, athleteId);
  if (!athlete) notFound();

  const action = editAthlete.bind(null, athlete.id);

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>Athlet bearbeiten</h1>
          <p>{athlete.firstName} {athlete.lastName}</p>
        </div>
        <Link href="/athletes">Zur Athletenliste</Link>
      </header>

      <section className="card">
        <form action={action} className="setup-form">
          <label>Vorname<input name="firstName" required maxLength={120} defaultValue={athlete.firstName} /></label>
          <label>Nachname<input name="lastName" required maxLength={120} defaultValue={athlete.lastName} /></label>
          <label>Geburtsdatum<input name="birthDate" type="date" required defaultValue={athlete.birthDate} /></label>
          <label>Referenzkategorie<input name="referenceCategory" required defaultValue={athlete.referenceCategory} /></label>
          <label>Körpergröße (cm)<input name="heightCm" type="number" min="80" max="250" required defaultValue={athlete.heightCm} /></label>
          <label>Gewicht (kg)<input name="weightKg" type="number" min="20" max="300" step="0.01" required defaultValue={athlete.currentWeightKgX100 / 100} /></label>
          <label>Hauptsportart<input name="primarySport" required defaultValue={athlete.primarySport} /></label>
          <label>Disziplin<input name="primaryDiscipline" required defaultValue={athlete.primaryDiscipline} /></label>
          <label>Trainingsstatus<input name="trainingStatus" required defaultValue={athlete.trainingStatus} /></label>
          <button type="submit">Änderungen speichern</button>
        </form>
      </section>
    </main>
  );
}
