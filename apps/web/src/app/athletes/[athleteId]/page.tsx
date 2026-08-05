import { authorize, deriveAthleteDashboardSummary } from '@masters/domain';
import {
  athleteIsMinor,
  getAthlete,
  getAthleteRetentionAssessment,
  getRecentAthleteLactateCurves,
  listActiveTrainers,
  listAthleteDiagnosticResultHistory,
  listAthleteSnapshots,
  listCoachAssignments,
  listConsents,
  listDeletionRequests,
  listGuardians,
  listReportVersions,
  listTestsForExecution,
  previewAthleteDeletion,
} from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { editAthlete } from '../actions';
import { addCoachAssignment, captureAthleteSnapshot } from './context-actions';
import { addConsent, withdrawAthleteConsent } from './consent-actions';
import { completeDeletionRequest, decideDeletionRequest, submitDeletionRequest } from './deletion-actions';
import { addGuardian, removeGuardian } from './guardian-actions';

export const dynamic = 'force-dynamic';

export default async function AthletePage({ params }: { params: Promise<{ athleteId: string }> }) {
  const context = await getTenantContext();
  authorize(context, 'athlete.manage');
  const { athleteId } = await params;
  const athlete = await getAthlete(db, context.tenantId, athleteId);
  if (!athlete) notFound();

  const [trainers, assignments, snapshots, consentRows, guardians, deletionRequests, deletionPreview, retentionAssessment, tenantTests, resultHistory, recentCurves] = await Promise.all([
    listActiveTrainers(db, context.tenantId),
    listCoachAssignments(db, context.tenantId, athlete.id),
    listAthleteSnapshots(db, context.tenantId, athlete.id),
    listConsents(db, context.tenantId, athlete.id),
    listGuardians(db, context.tenantId, athlete.id),
    listDeletionRequests(db, context.tenantId, athlete.id),
    previewAthleteDeletion(db, context.tenantId, athlete.id),
    getAthleteRetentionAssessment(db, context.tenantId, athlete.id),
    listTestsForExecution(db, context.tenantId),
    listAthleteDiagnosticResultHistory(db, context.tenantId, athlete.id),
    getRecentAthleteLactateCurves(db, context.tenantId, athlete.id, 5),
  ]);
  const athleteTests = tenantTests
    .filter(({ athlete: testAthlete }) => testAthlete.id === athlete.id)
    .map(({ test, plan }) => ({
      testId: test.id,
      status: test.status,
      createdAt: test.createdAt,
      expectedLt2Watts: plan.expectedLt2Watts,
      startWatts: plan.startWatts,
      incrementWatts: plan.incrementWatts,
      maximumStages: plan.maximumStages,
    }));
  const recentTestIds = new Set(recentCurves.map((curve) => curve.testId));
  const reportVersions = (await Promise.all(
    athleteTests
      .filter((test) => recentTestIds.has(test.testId))
      .map((test) => listReportVersions(db, context.tenantId, test.testId)),
  )).flat();
  const dashboardSummary = deriveAthleteDashboardSummary(athleteTests);
  const editAction = editAthlete.bind(null, athlete.id);
  const assignmentAction = addCoachAssignment.bind(null, athlete.id);
  const snapshotAction = captureAthleteSnapshot.bind(null, athlete.id);
  const consentAction = addConsent.bind(null, athlete.id);
  const guardianAction = addGuardian.bind(null, athlete.id);
  const deletionAction = submitDeletionRequest.bind(null, athlete.id);
  const blocked = Boolean(athlete.consentBlockedAt);
  const minor = athleteIsMinor(athlete.birthDate);
  const activeGuardian = guardians.some((guardian) => !guardian.revokedAt && (!guardian.validUntil || guardian.validUntil >= new Date().toISOString().slice(0, 10)));
  const openDeletionRequest = deletionRequests.find((request) => request.status === 'REQUESTED');
  const retentionBasisLabel = retentionAssessment.basis === 'LAST_TEST'
    ? `letzter durchgeführter Test · Tenant-Frist ${retentionAssessment.tenantRetentionYears} Jahr(e)`
    : retentionAssessment.basis === 'MANAGED_PROFILE_NO_TEST'
      ? 'verwaltetes Profil ohne Test · 12 Monate ab Anlage'
      : 'verknüpftes Profil ohne Test · manuelle Prüfung';

  return (
    <main>
      <header className="app-header">
        <div><h1>Athlet bearbeiten</h1><p>{athlete.firstName} {athlete.lastName}</p></div>
        <Link href="/athletes">Zur Athletenliste</Link>
      </header>

      {blocked && <section className="card" role="alert"><h2>Nutzung gesperrt</h2><p>Für diesen Athleten besteht eine Einwilligungs- oder Löschsperre. Neue Tests dürfen nicht gestartet werden.</p></section>}
      {minor && !activeGuardian && <section className="card" role="alert"><h2>Guardian erforderlich</h2><p>Für diesen minderjährigen Athleten ist noch keine aktive gesetzliche Vertretung dokumentiert. Ein Teststart muss blockiert bleiben.</p></section>}

      <section className="card" aria-labelledby="athlete-dashboard-heading">
        <p className="eyebrow">Athleten-Dashboard</p>
        <h2 id="athlete-dashboard-heading">Sportdiagnostischer Verlauf</h2>
        <dl aria-label="Testübersicht">
          <div><dt>Tests gesamt</dt><dd>{dashboardSummary.totalTests}</dd></div>
          <div><dt>Aktiv</dt><dd>{dashboardSummary.activeTests}</dd></div>
          <div><dt>Datenprüfung</dt><dd>{dashboardSummary.reviewTests}</dd></div>
          <div><dt>Freigegeben</dt><dd>{dashboardSummary.completedTests}</dd></div>
          <div><dt>Kurven verfügbar</dt><dd>{recentCurves.filter((curve) => curve.points.length >= 2).length}</dd></div>
          <div><dt>Berichtsversionen</dt><dd>{reportVersions.length}</dd></div>
        </dl>
        {dashboardSummary.latestTestAt && <p>Letzter Test: {new Date(dashboardSummary.latestTestAt).toLocaleString('de-DE')}</p>}
        {athleteTests.length > 0 && (
          <p>
            <Link href={`/athletes/${athlete.id}/curve`}>Aktuelle Laktatkurve öffnen</Link>
            {' · '}
            <Link href={`/athletes/${athlete.id}/comparison`}>Bis zu fünf Tests vergleichen</Link>
          </p>
        )}
        {athleteTests.length === 0 ? (
          <p>Noch keine Tests für diesen Athleten vorhanden.</p>
        ) : (
          <ol>
            {athleteTests.map((test) => (
              <li key={test.testId}>
                <strong>{test.status}</strong> · LT2-Plan {test.expectedLt2Watts} W · Start {test.startWatts} W · +{test.incrementWatts} W · max. {test.maximumStages} Stufen · <Link href={`/tests/${test.testId}`}>Test öffnen</Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card" aria-labelledby="report-history-heading">
        <h2 id="report-history-heading">Berichte</h2>
        <p>Unveränderliche deutsch- und englischsprachige PDF-Berichtsversionen der jüngsten Tests.</p>
        {reportVersions.length === 0 ? (
          <p>Noch keine Berichtsversion vorhanden.</p>
        ) : (
          <ol>
            {reportVersions.map((report) => (
              <li key={report.id}>
                <strong>{report.locale.toUpperCase()} · Version {report.versionNumber}</strong> · {new Date(report.createdAt).toLocaleString('de-DE')} · <Link href={`/api/tests/${report.testId}/reports/${report.id}`}>PDF herunterladen</Link> · <Link href={`/tests/${report.testId}`}>Test öffnen</Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card" aria-labelledby="diagnostic-result-history-heading">
        <h2 id="diagnostic-result-history-heading">Diagnostische Ergebnisversionen</h2>
        <p>Unveränderliche, versionierte Ergebnis-Snapshots mit kryptografischem Referenz-Hash.</p>
        {resultHistory.length === 0 ? (
          <p>Noch keine diagnostische Ergebnisversion vorhanden.</p>
        ) : (
          <ol>
            {resultHistory.map((result) => (
              <li key={result.id}>
                <strong>Version {result.versionNumber}</strong> · {new Date(result.createdAt).toLocaleString('de-DE')} · Teststatus {result.testStatus} · Schema {result.schemaVersion} · <code>{result.resultHash}</code> · <Link href={`/tests/${result.testId}`}>Test öffnen</Link>
              </li>
            ))}
          </ol>
        )}
      </section>

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
        <h2>Gesetzliche Vertretung</h2>
        {!minor && <p>Der Athlet ist volljährig. Guardian-Daten sind optional und werden normalerweise nicht benötigt.</p>}
        <form action={guardianAction} className="setup-form">
          <label>Vollständiger Name<input name="fullName" required maxLength={160} /></label>
          <label>Beziehung<input name="relationship" required placeholder="Mutter, Vater, Vormund" /></label>
          <label>E-Mail<input name="email" type="email" /></label>
          <label>Telefon<input name="phone" /></label>
          <label>Gültig bis<input name="validUntil" type="date" /></label>
          <button type="submit">Vertretung dokumentieren</button>
        </form>
        {guardians.length === 0 ? <p>Noch keine gesetzliche Vertretung dokumentiert.</p> : <ul>{guardians.map((guardian) => {
          const revokeAction = removeGuardian.bind(null, athlete.id);
          return <li key={guardian.id}><strong>{guardian.fullName}</strong> · {guardian.relationship} · {guardian.revokedAt ? 'widerrufen' : 'aktiv'}{!guardian.revokedAt && <form action={revokeAction} className="setup-form"><input type="hidden" name="guardianId" value={guardian.id} /><label>Grund der Aufhebung<input name="reason" required minLength={3} /></label><button type="submit">Vertretung aufheben</button></form>}</li>;
        })}</ul>}
      </section>

      <section className="card">
        <h2>Einwilligungen</h2>
        <form action={consentAction} className="setup-form"><label>Einwilligungstyp<input name="consentType" required defaultValue="DIAGNOSTIC_TESTING" /></label><label>Dokumentversion<input name="documentVersion" required placeholder="v1.0" /></label><button type="submit">Einwilligung erteilen</button></form>
        {consentRows.length === 0 ? <p>Noch keine Einwilligung dokumentiert.</p> : <ul>{consentRows.map((consent) => {
          const withdrawAction = withdrawAthleteConsent.bind(null, athlete.id);
          return <li key={consent.id}><strong>{consent.consentType}</strong> · {consent.documentVersion} · {consent.status}{consent.status === 'GRANTED' && <form action={withdrawAction} className="setup-form"><input type="hidden" name="consentId" value={consent.id} /><label>Widerrufsgrund<input name="reason" required minLength={3} /></label><button type="submit">Einwilligung widerrufen</button></form>}</li>;
        })}</ul>}
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

      <section className="card">
        <h2>Löschantrag</h2>
        <p>Vorschau: {deletionPreview.relatedRecords.snapshots} Snapshots, {deletionPreview.relatedRecords.coachAssignments} Trainerzuordnungen, {deletionPreview.relatedRecords.consents} Einwilligungen und {deletionPreview.relatedRecords.guardians} Guardian-Einträge. Auditdaten bleiben erhalten.</p>
        <p><strong>Aufbewahrungsprüfung:</strong> {retentionBasisLabel}.</p>
        {retentionAssessment.reason === 'RETENTION_ACTIVE' && retentionAssessment.retainUntil && (
          <p role="status">Irreversible Pseudonymisierung oder Entfernung bleibt bis {new Date(retentionAssessment.retainUntil).toLocaleString('de-DE')} gesperrt. Soft-Delete und Nutzungssperre bleiben davon unberührt.</p>
        )}
        {retentionAssessment.reason === 'RETENTION_EXPIRED' && (
          <p role="status">Die Aufbewahrungsfrist ist abgelaufen. Eine irreversible Verarbeitung ist damit nur fristseitig zulässig und benötigt weiterhin eine separate, auditierte Freigabe.</p>
        )}
        {retentionAssessment.reason === 'MANUAL_REVIEW_REQUIRED' && (
          <p role="status">Für dieses verknüpfte Profil ohne Test existiert keine automatische Fristfreigabe. Vor einer irreversiblen Verarbeitung ist eine manuelle Aufbewahrungsprüfung erforderlich.</p>
        )}
        {!openDeletionRequest && !deletionRequests.some((request) => request.status === 'APPROVED') && <form action={deletionAction} className="setup-form"><label>Begründung<input name="reason" required minLength={3} /></label><button type="submit">Löschantrag stellen und Nutzung sperren</button></form>}
        {deletionRequests.length === 0 ? <p>Noch kein Löschantrag vorhanden.</p> : <ol>{deletionRequests.map((request) => {
          const decisionAction = decideDeletionRequest.bind(null, athlete.id);
          const completionAction = completeDeletionRequest.bind(null, athlete.id);
          return <li key={request.id}><strong>{request.status}</strong> · {new Date(request.requestedAt).toLocaleString('de-DE')} · {request.reason}
            {request.status === 'REQUESTED' && <form action={decisionAction} className="setup-form"><input type="hidden" name="requestId" value={request.id} /><label>Entscheidung<select name="decision" defaultValue="APPROVED"><option value="APPROVED">Genehmigen</option><option value="REJECTED">Ablehnen</option></select></label><label>Entscheidungsgrund<input name="reason" required minLength={3} /></label><button type="submit">Entscheidung dokumentieren</button></form>}
            {request.status === 'APPROVED' && <form action={completionAction} className="setup-form"><input type="hidden" name="requestId" value={request.id} /><label>Abschlussvermerk<input name="reason" required minLength={3} /></label><button type="submit">Soft-Delete abschließen</button></form>}
          </li>;
        })}</ol>}
      </section>
    </main>
  );
}
