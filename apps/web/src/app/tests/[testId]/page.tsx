import {
  TEST_START_SAFETY_CHECKLIST_ITEMS,
  authorize,
} from '@masters/domain';
import {
  getTestForExecution,
  getTestReviewRows,
  getTestStartReadiness,
  getTestTimerPlan,
} from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import {
  confirmSafety,
  finishRunningTest,
  startPlannedTest,
} from '../actions';
import { LiveTestSession } from './live-test-session';
import { getReviewPlausibilityWarnings } from './review-plausibility';
import { TestReviewTable } from './test-review-table';

export const dynamic = 'force-dynamic';

const safetyLabels = {
  identityVerified: 'Identität des Athleten geprüft',
  consentValid: 'Einwilligung ist gültig',
  deviceTypeVerified: 'Gerätetyp geprüft',
  testPlanVerified: 'Testplan geprüft',
  athleteInformed: 'Athlet über Ablauf informiert',
  subjectiveReadinessConfirmed: 'Subjektive Bereitschaft bestätigt',
  currentComplaintsAsked: 'Aktuelle Beschwerden abgefragt',
  measurementEquipmentReady: 'Messausrüstung bereit',
  emergencyProceduresKnown: 'Notfallverfahren bekannt',
  sensorValuesPlausibleOrNotConnected: 'Sensorwerte plausibel oder Sensor nicht verbunden',
  trainerResponsibilityAccepted: 'Verantwortung für Start und Abbruch übernommen',
} as const;

export default async function TestPage({ params }: { params: Promise<{ testId: string }> }) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  const { testId } = await params;
  const execution = await getTestForExecution(db, context.tenantId, testId);
  if (!execution || (
    execution.test.status !== 'IN_PROGRESS'
    && execution.test.conductingTrainerUserId !== context.userId
    && !(execution.test.status === 'DATA_REVIEW' && context.role === 'TENANT_ADMIN')
  )) notFound();

  const timer = await getTestTimerPlan(
    db,
    context.tenantId,
    { userId: context.userId, role: context.role },
    testId,
  );
  const readiness = execution.test.status === 'PLANNED'
    ? await getTestStartReadiness(db, context.tenantId, testId)
    : null;
  const reviewRows = execution.test.status === 'DATA_REVIEW'
    ? await getTestReviewRows(
      db,
      context.tenantId,
      { userId: context.userId, role: context.role },
      testId,
    )
    : null;
  const warnings = reviewRows ? getReviewPlausibilityWarnings(reviewRows) : [];
  const safetyAction = confirmSafety.bind(null, testId);
  const startAction = startPlannedTest.bind(null, testId);
  const finishAction = finishRunningTest.bind(null, testId);

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>Live-Test</h1>
          <p>{execution.athlete.firstName} {execution.athlete.lastName} · {execution.test.deviceType}</p>
        </div>
        <Link href="/tests">Zur Testübersicht</Link>
      </header>

      <section className="card">
        <h2>Testplan</h2>
        <p>
          LT2 {execution.plan.expectedLt2Watts} W · Start {execution.plan.startWatts} W ·
          {' '}+{execution.plan.incrementWatts} W · {execution.plan.maximumStages} Stufen
        </p>
        <p>Geplante Gesamtdauer: {Math.round(timer.totalDurationSeconds / 60)} Minuten</p>
      </section>

      {execution.test.status === 'PLANNED' && readiness && !readiness.confirmation && (
        <section className="card">
          <h2>Sicherheitscheck vor dem Start</h2>
          <form action={safetyAction} className="safety-checklist">
            {TEST_START_SAFETY_CHECKLIST_ITEMS.map((item) => (
              <label key={item}>
                <input name={item} type="checkbox" required />
                {safetyLabels[item]}
              </label>
            ))}
            <button type="submit">Sicherheitscheck bestätigen</button>
          </form>
        </section>
      )}

      {execution.test.status === 'PLANNED' && readiness?.confirmation && (
        <section className="card">
          <h2>Startbereit</h2>
          <p>Der unveränderliche Testplan und alle Sicherheitsbestätigungen liegen vor.</p>
          <form action={startAction}>
            <button type="submit" className="primary-action">Test starten</button>
          </form>
        </section>
      )}

      {execution.test.status === 'IN_PROGRESS' && execution.test.startedAt && (
        <LiveTestSession
          plan={timer}
          testId={testId}
          startedAt={execution.test.startedAt}
          finishAction={finishAction}
        />
      )}

      {execution.test.status === 'DATA_REVIEW' && (
        <>
          <section className="card" role="status">
            <h2>Datenprüfung</h2>
            <p>Der Test wurde beendet und befindet sich jetzt in der Datenprüfung.</p>
          </section>
          {warnings.length > 0 && (
            <section className="card" aria-labelledby="plausibility-heading">
              <p className="eyebrow">Automatische Review-Hilfe</p>
              <h2 id="plausibility-heading">Plausibilitätswarnungen</h2>
              <p>Diese Hinweise verändern keine Messwerte und keinen Qualitätsstatus.</p>
              <ul aria-label="Plausibilitätswarnungen">
                {warnings.map((warning, index) => (
                  <li key={`${warning.code}:${warning.stageNumber ?? 'all'}:${index}`}>
                    <strong>{warning.severity === 'WARNING' ? 'Warnung' : 'Hinweis'}:</strong>
                    {' '}{warning.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {reviewRows && <TestReviewTable testId={testId} rows={reviewRows} />}
        </>
      )}
    </main>
  );
}
