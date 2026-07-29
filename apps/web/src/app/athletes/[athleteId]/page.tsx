import { authorize } from '@masters/domain';
import {
  getAthlete,
  listActiveTrainers,
  listAthleteSnapshots,
  listCoachAssignments,
  listConsents,
} from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { editAthlete } from '../actions';
import { addCoachAssignment, captureAthleteSnapshot } from './context-actions';
import { addConsent, withdrawAthleteConsent } from './consent-actions';

export const dynamic = 'force-dynamic';

function isMinor(birthDate: string, now = new Date()) {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birth.getUTCMonth()
    || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age < 18;
}

export default async function AthletePage({ params }: { params: Promise<{ athleteId: string }> }) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const { athleteId } = await params;
  const athlete = await getAthlete(db, context.tenantId, athleteId);
  if (!athlete) notFound();

  const [trainers, assignments, snapshots, consentRows] = await Promise.all([
    listActiveTrainers(db, context.tenantId),
    listCoachAssignments(db, context.tenantId, athlete.id),
    listAthleteSnapshots(db, context.tenantId, athlete.id),
    listConsents(db, context.tenantId, athlete.id),
  ]);
  const editAction = editAthlete.bind(null, athlete.id);
  const assignmentAction = addCoachAssignment.bind(null, athlete.id);
  const snapshotAction = captureAthleteSnapshot.bind(null, athlete.id);
  const consentAction = addConsent.bind(null, athlete.id);
  const blocked = Boolean(athlete.consentBlockedAt);

  return (
    <main>
      <header className="app-header">
        <div><h1>Athlet bearbeiten</h1><p>{athlete.firstName} {athlete.lastName}</p></div>
        <Link href="/athletes">Zur Athletenliste</Link>
      </header>

      {blocked && <section className="card" role="alert"><h2>Nutzung gesperrt</h2><p>Die Einwilligung wurde widerrufen. Neue Tests dürfen erst nach erneuter Erteilung gestartet werden.</p></section>}
      {isMinor(athlete.birthDate) && <section className="card"><h2>Guardian erforderlich</h2><p>Der Athlet ist minderjährig. Vor Testbeginn muss eine gesetzliche Vertretung dokumentiert werden.</p></section>}

      <section className="card">
        <h2>Stammdaten</h2>
        <form action={editAction} className="setup-form">
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

      <section className="card">
        <h2>Einwilligungen</h2>
        <form action={consentAction} className="setup-form">
          <label>Einwilligungstyp<input name="consentType" required defaultValue="DIAGNOSTIC_TESTING" /></label>
          <label>Dokumentversion<input name="documentVersion" required placeholder="v1.0" /></label>
          <button type="submit">Einwilligung erteilen</button>
        </form>
        {consentRows.length === 0 ? <p>Noch keine Einwilligung dokumentiert.</p> : (
          <ul>{consentRows.map((consent) => {
            const withdrawAction = withdrawAthleteConsent.bind(null, athlete.id);
            return <li key={consent.id}>
              <strong>{consent.consentType}</strong> · {consent.documentVersion} · {consent.status}
              {consent.status === 'GRANTED' && <form action={withdrawAction} className="setup-form">
                <input type="hidden" name="consentId" value={consent.id} />
                <label>Widerrufsgrund<input name="reason" required minLength={3} /></label>
                <button type="submit">Einwilligung widerrufen</button>
              </form>}
            </li>;
          })}</ul>
        )}
      </section>

      <section className="card">
        <h2>Trainerzuordnung</h2>
        {assignments.length === 0 ? <p>Noch kein Trainer zugeordnet.</p> : <ul>{assignments.map((assignment) => <li key={assignment.id}>{assignment.displayName} ({assignment.email}){assignment.isPrimary ? ' · Haupttrainer' : ''}</li>)}</ul>}
        {trainers.length === 0 ? <p>Im Tenant ist noch keine aktive Trainer-Mitgliedschaft vorhanden.</p> : <form action={assignmentAction} className="setup-form"><label>Trainer<select name="coachUserId" required defaultValue=""><option value="" disabled>Trainer auswählen</option>{trainers.map((trainer) => <option key={trainer.userId} value={trainer.userId}>{trainer.displayName} · {trainer.email}</option>)}</select></label><label><input name="isPrimary" type="checkbox" /> Als Haupttrainer festlegen</label><button type="submit">Trainer zuordnen</button></form>}
      </section>

      <section className="card">
        <h2>Athleten-Snapshots</h2><p>Snapshots sind unveränderliche, versionierte Abbilder der aktuellen Stammdaten.</p>
        <form action={snapshotAction}><button type="submit">Snapshot erzeugen</button></form>
        {snapshots.length === 0 ? <p>Noch kein Snapshot vorhanden.</p> : <ol>{snapshots.map((snapshot) => <li key={snapshot.id}>Version {snapshot.version} · {new Date(snapshot.createdAt).toLocaleString('de-DE')}</li>)}</ol>}
      </section>
    </main>
  );
}
