import {
  TEST_START_SAFETY_CHECKLIST_ITEMS,
  assessReidentificationRisk,
  authorize,
} from '@masters/domain';
import {
  getAnalysisExportCohortEvidence,
  getTestForExecution,
  getTestReviewRows,
  getTestStartReadiness,
  getTestTimerPlan,
} from '@masters/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WorkspaceNav } from '@/components/workspace-nav';
import { readAnalysisExportMinimumEquivalenceClassSize } from '@/lib/analysis-export-policy';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import {
  confirmSafety,
  finishRunningTest,
  startPlannedTest,
} from '../actions';
import { LiveTestSession } from './live-test-session';
import { ReportDeliveryControls } from './report-delivery-controls';
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

const statusLabels = {
  PLANNED: 'Geplant',
  IN_PROGRESS: 'Läuft',
  DATA_REVIEW: 'Datenprüfung',
  INTERPRETED: 'Interpretiert',
  RELEASED: 'Freigegeben',
  ARCHIVED: 'Archiviert',
} as const;

const statusClasses = {
  PLANNED: 'status-planned',
  IN_PROGRESS: 'status-running',
  DATA_REVIEW: 'status-review',
  INTERPRETED: 'status-complete',
  RELEASED: 'status-complete',
  ARCHIVED: 'status-archived',
} as const;

export default async function TestPage({ params }: { params: Promise<{ testId: string }> }) {
  const context = await getTenantContext();
  authorize(context, 'test.run');
  const { testId } = await params;
  const execution = await getTestForExecution(db, context.tenantId, testId);
  const tenantAdminMayReviewOrReport = context.role === 'TENANT_ADMIN'
    && (execution?.test.status === 'DATA_REVIEW' || execution?.test.status === 'RELEASED');
  if (!execution || (
    execution.test.status !== 'IN_PROGRESS'
    && execution.test.conductingTrainerUserId !== context.userId
    && !tenantAdminMayReviewOrReport
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
  const minimumEquivalenceClassSize = execution.test.status === 'RELEASED'
    ? readAnalysisExportMinimumEquivalenceClassSize()
    : null;
  const analysisExportCohort = execution.test.status === 'RELEASED' && minimumEquivalenceClassSize !== null
    ? await getAnalysisExportCohortEvidence(db, context.tenantId, testId)
    : null;
  const analysisExportAssessment = minimumEquivalenceClassSize !== null && analysisExportCohort
    ? assessReidentificationRisk(
      { equivalenceClassSize: analysisExportCohort.equivalenceClassSize },
      { minimumEquivalenceClassSize },
    )
    : null;
  const safetyAction = confirmSafety.bind(null, testId);
  const startAction = startPlannedTest.bind(null, testId);
  const finishAction = finishRunningTest.bind(null, testId);

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Diagnostik-Workflow</p>
          <h1>Live-Test</h1>
          <p>{execution.athlete.firstName} {execution.athlete.lastName} · {execution.test.deviceType}</p>
        </div>
        <Link className="secondary-action" href="/tests">Zur Testübersicht</Link>
      </header>

      <WorkspaceNav />

      <section className="card planning-card">
        <span className={`status-chip ${statusClasses[execution.test.status]}`}>{statusLabels[execution.test.status]}</span>
        <h2>Testplan</h2>
        <p>
          LT2 {execution.plan.expectedLt2Watts} W · Start {execution.plan.startWatts} W ·
          {' '}+{execution.plan.incrementWatts} W · {execution.plan.maximumStages} Stufen
        </p>
        <p className="muted">Geplante Gesamtdauer: {Math.round(timer.totalDurationSeconds / 60)} Minuten</p>
      </section>

      {execution.test.status === 'PLANNED' && readiness && !readiness.confirmation && (
        <section className="card dashboard-card">
          <p className="eyebrow">Sicherheit vor Geschwindigkeit</p>
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
        <section className="card dashboard-card">
          <p className="eyebrow">Bereit</p>
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
          <section className="notice notice-info" role="status">
            <strong>Datenprüfung:</strong> Der Test wurde beendet und befindet sich jetzt in der fachlichen Review-Phase.
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

      {(execution.test.status === 'DATA_REVIEW' || execution.test.status === 'RELEASED') && (
        <section className="card" aria-labelledby="test-export-heading">
          <p className="eyebrow">Portabilität</p>
          <h2 id="test-export-heading">Testexport</h2>
          <p>Messwerte und Testmetadaten in einem portablen, versionierten Exportformat.</p>
          <p>
            <a href={`/api/tests/${testId}/export?format=csv`}>CSV herunterladen</a>
            {' · '}<a href={`/api/tests/${testId}/export?format=json`}>JSON herunterladen</a>
            {' · '}<a href={`/api/tests/${testId}/export?format=markdown`}>Markdown herunterladen</a>
          </p>
        </section>
      )}

      {execution.test.status === 'RELEASED' && (
        <section className="card" aria-labelledby="analysis-export-heading">
          <p className="eyebrow">Datenschutz</p>
          <h2 id="analysis-export-heading">Anonymisierter Analyseexport</h2>
          {minimumEquivalenceClassSize === null ? (
            <p className="notice notice-warning" role="status">
              Analyseexport deaktiviert: Es ist noch keine gültige Mindestgröße für die Vergleichsgruppe konfiguriert.
            </p>
          ) : !analysisExportCohort || !analysisExportAssessment ? (
            <p className="notice notice-warning" role="status">Analyseexport nicht verfügbar: Die Vergleichsgruppe konnte nicht bestimmt werden.</p>
          ) : analysisExportAssessment.exportAllowed ? (
            <>
              <p className="notice notice-info" role="status">
                Freigegeben: Vergleichsgruppe {analysisExportAssessment.equivalenceClassSize} · Mindestgröße {minimumEquivalenceClassSize}.
              </p>
              <p><a href={`/api/tests/${testId}/analysis-export`}>Anonymisierten Analyseexport herunterladen</a></p>
            </>
          ) : (
            <p className="notice notice-danger" role="alert">
              Reidentifikationswarnung: Vergleichsgruppe {analysisExportAssessment.equivalenceClassSize} liegt unter der Mindestgröße {minimumEquivalenceClassSize}. Der Export bleibt gesperrt.
            </p>
          )}
        </section>
      )}

      {execution.test.status === 'RELEASED' && <ReportDeliveryControls testId={testId} />}
    </main>
  );
}
