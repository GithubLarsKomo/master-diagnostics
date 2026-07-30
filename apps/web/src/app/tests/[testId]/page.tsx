import {
  TEST_START_SAFETY_CHECKLIST_ITEMS,
  authorize,
} from '@masters/domain';
import {
  getTestForExecution,
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
import { LiveTestTimer } from './live-test-timer';

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

const terminationLabels = {
  REGULAR_EXHAUSTION: 'Reguläre Ausbelastung',
  VOLUNTARY_STOP: 'Freiwilliger Abbruch',
  TECHNICAL_FAILURE: 'Technische Störung',
  PAIN_OR_DISCOMFORT: 'Schmerzen oder Unwohlsein',
  ABNORMAL_HEART_RATE: 'Auffällige Herzfrequenz',
  PROTOCOL_ERROR: 'Protokollfehler',
  OTHER: 'Sonstiger Grund',
} as const;

export default async function TestPage({
  params,
}: {
  params: Promise<{ testId: string }>;
}) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  const { testId } = await params;
  const execution = await getTestForExecution(db, context.tenantId, testId);
  if (!execution || execution.test.conductingTrainerUserId !== context.userId) notFound();

  const timer = await getTestTimerPlan(
    db,
    context.tenantId,
    { userId: context.userId, role: context.role },
    testId,
  );
  const readiness = execution.test.status === 'PLANNED'
    ? await getTestStartReadiness(db, context.tenantId, testId)
    : null;
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
        <>
          <LiveTestTimer plan={timer} startedAt={execution.test.startedAt} />
          <section className="card critical-action" aria-label="Testabschluss">
            <h2>Test sofort abbrechen</h2>
            <p>Diese Aktion bleibt während des gesamten laufenden Tests verfügbar.</p>
            <form action={finishAction} className="setup-form">
              <label>Abschluss- oder Abbruchgrund
                <select name="reason" required defaultValue="">
                  <option value="" disabled>Grund auswählen</option>
                  {Object.entries(terminationLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>Vermerk
                <textarea name="notes" rows={3} maxLength={2000} />
              </label>
              <button type="submit">Test sofort abbrechen</button>
            </form>
          </section>
        </>
      )}

      {execution.test.status === 'DATA_REVIEW' && (
        <section className="card" role="status">
          <h2>Datenprüfung</h2>
          <p>Der Test wurde beendet und befindet sich jetzt in der Datenprüfung.</p>
        </section>
      )}
    </main>
  );
}
