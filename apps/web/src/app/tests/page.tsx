import { authorize } from '@masters/domain';
import {
  listAthletes,
  listProtocolTemplateVersions,
  listProtocolTemplates,
  listTestsForExecution,
} from '@masters/db';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { planTest } from './actions';

export const dynamic = 'force-dynamic';

const statusLabels = {
  PLANNED: 'Geplant',
  IN_PROGRESS: 'Läuft',
  DATA_REVIEW: 'Datenprüfung',
  INTERPRETED: 'Interpretiert',
  RELEASED: 'Freigegeben',
  ARCHIVED: 'Archiviert',
} as const;

export default async function TestsPage() {
  const context = await getTenantContext();
  authorize(context, 'test.plan');
  const [athletes, templates, testRows] = await Promise.all([
    listAthletes(db, context.tenantId),
    listProtocolTemplates(db, context.tenantId),
    listTestsForExecution(db, context.tenantId),
  ]);
  const versionGroups = await Promise.all(templates
    .filter((template) => template.active)
    .map(async (template) => ({
      template,
      versions: await listProtocolTemplateVersions(db, context.tenantId, template.id),
    })));
  const protocolOptions = versionGroups.flatMap(({ template, versions }) => (
    versions.map((version) => ({
      id: version.id,
      label: `${template.name} · Version ${version.versionNumber}`,
    }))
  ));
  const eligibleAthletes = athletes.filter((athlete) => !athlete.consentBlockedAt);
  const blockedAthleteCount = athletes.length - eligibleAthletes.length;
  const canPlan = eligibleAthletes.length > 0 && protocolOptions.length > 0;

  return (
    <main>
      <header className="app-header">
        <div><h1>Tests</h1><p>Stufentests planen, vorbereiten und durchführen.</p></div>
        <Link href="/">Zur Übersicht</Link>
      </header>

      <section className="grid" aria-label="Testbestand">
        {testRows.length === 0 ? (
          <article className="card"><h2>Noch keine Tests</h2><p>Plane den ersten Test über das Formular.</p></article>
        ) : testRows.map(({ test, athlete, plan }) => (
          <article className="card" key={test.id}>
            <h2>{athlete.firstName} {athlete.lastName}</h2>
            <p><strong>{statusLabels[test.status]}</strong> · {test.deviceType}</p>
            <p>LT2 {plan.expectedLt2Watts} W · {plan.maximumStages} Stufen</p>
            <p>Start {plan.startWatts} W · +{plan.incrementWatts} W</p>
            <Link href={`/tests/${test.id}`}>Test öffnen</Link>
          </article>
        ))}
      </section>

      <section className="card">
        <h2>Test planen</h2>
        {blockedAthleteCount > 0 && (
          <p role="status">
            {blockedAthleteCount === 1
              ? '1 Athlet ist wegen einer Einwilligungs- oder Löschsperre nicht für neue Tests auswählbar.'
              : `${blockedAthleteCount} Athleten sind wegen einer Einwilligungs- oder Löschsperre nicht für neue Tests auswählbar.`}
          </p>
        )}
        {!canPlan ? (
          <p>Für die Planung werden mindestens ein freigegebener Athlet und eine aktive Protokollversion benötigt.</p>
        ) : (
          <form action={planTest} className="setup-form">
            <label>Athlet
              <select name="athleteId" required defaultValue="">
                <option value="" disabled>Athlet auswählen</option>
                {eligibleAthletes.map((athlete) => (
                  <option key={athlete.id} value={athlete.id}>
                    {athlete.firstName} {athlete.lastName}
                  </option>
                ))}
              </select>
            </label>
            <label>Protokoll
              <select name="protocolVersionId" required defaultValue="">
                <option value="" disabled>Protokoll auswählen</option>
                {protocolOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>Erwartete LT2 (W)
              <input name="expectedLt2Watts" type="number" min="25" max="2000" defaultValue="350" required />
            </label>
            <label>Stufenzahl
              <input name="stageCount" type="number" min="5" max="8" defaultValue="7" required />
            </label>
            <label>Startleistung (W, optional)
              <input name="startPowerWatts" type="number" min="5" max="2000" />
            </label>
            <label>Inkrement (W, optional)
              <input name="incrementWatts" type="number" min="5" max="2000" />
            </label>
            <button type="submit">Testplan erstellen</button>
          </form>
        )}
      </section>
    </main>
  );
}
