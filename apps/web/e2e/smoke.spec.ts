import { expect, test, type Page } from '@playwright/test';
import { db } from '../src/lib/db';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function signIn(page: Page) {
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();
}

async function expectTenantAdminHome(page: Page) {
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3000\/$/);
  await expect(page.getByRole('heading', { name: 'Masters Diagnostics' })).toBeVisible();
  await expect(page.getByText(/Club Admin · TENANT_ADMIN/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tenant-Kontext' })).toBeVisible();
}

test('bootstraps a club and completes the first live test workflow', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Clubname', { exact: true }).fill('Ratzeburger Ruderclub');
  await page.getByLabel('Slug', { exact: true }).fill('rrc');
  await page.getByLabel('Name', { exact: true }).fill('Club Admin');
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Installation abschließen' }).click();

  await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/sign-in');
  if (new URL(page.url()).pathname === '/sign-in') await signIn(page);
  await expectTenantAdminHome(page);

  await page.getByRole('link', { name: 'Athleten öffnen' }).click();
  await page.getByLabel('Vorname', { exact: true }).fill('Petra');
  await page.getByLabel('Nachname', { exact: true }).fill('Muster');
  await page.getByLabel('Geburtsdatum', { exact: true }).fill('2012-04-18');
  await page.getByLabel('Referenzkategorie', { exact: true }).fill('Junior');
  await page.getByLabel('Körpergröße (cm)', { exact: true }).fill('174');
  await page.getByLabel('Gewicht (kg)', { exact: true }).fill('68.5');
  await page.getByLabel('Disziplin', { exact: true }).selectOption('Skullen');
  await page.getByLabel('Trainingsstatus', { exact: true }).selectOption('leistungsorientiert');
  await page.getByRole('button', { name: 'Athlet speichern' }).click();

  await page.getByRole('link', { name: 'Bearbeiten' }).click();
  await expect(page.getByRole('heading', { name: 'Guardian erforderlich' })).toBeVisible();

  await page.getByLabel('Vollständiger Name', { exact: true }).fill('Erika Muster');
  await page.getByLabel('Beziehung', { exact: true }).fill('Mutter');
  await page.getByRole('button', { name: 'Vertretung dokumentieren' }).click();
  await expect(page.getByRole('heading', { name: 'Guardian erforderlich' })).toBeHidden();
  await expect(page.getByText(/Erika Muster · Mutter · aktiv/)).toBeVisible();

  await page.getByLabel('Grund der Aufhebung', { exact: true }).fill('Vertretung beendet');
  await page.getByRole('button', { name: 'Vertretung aufheben' }).click();
  await expect(page.getByRole('heading', { name: 'Guardian erforderlich' })).toBeVisible();
  await expect(page.getByText(/Erika Muster · Mutter · widerrufen/)).toBeVisible();

  await page.getByLabel('Dokumentversion', { exact: true }).fill('v1.0');
  await page.getByRole('button', { name: 'Einwilligung erteilen' }).click();
  await expect(page.getByText(/DIAGNOSTIC_TESTING · v1.0 · GRANTED/)).toBeVisible();

  await page.getByLabel('Widerrufsgrund', { exact: true }).fill('Auf Wunsch des Athleten');
  await page.getByRole('button', { name: 'Einwilligung widerrufen' }).click();
  await expect(page.getByRole('heading', { name: 'Nutzung gesperrt' })).toBeVisible();
  await expect(page.getByText(/DIAGNOSTIC_TESTING · v1.0 · WITHDRAWN/)).toBeVisible();

  await page.goto('/athletes');
  await page.getByLabel('Vorname', { exact: true }).fill('Max');
  await page.getByLabel('Nachname', { exact: true }).fill('Test');
  await page.getByLabel('Geburtsdatum', { exact: true }).fill('1990-05-20');
  await page.getByLabel('Referenzkategorie', { exact: true }).fill('Masters A');
  await page.getByLabel('Körpergröße (cm)', { exact: true }).fill('182');
  await page.getByLabel('Gewicht (kg)', { exact: true }).fill('78');
  await page.getByLabel('Disziplin', { exact: true }).selectOption('Skullen');
  await page.getByLabel('Trainingsstatus', { exact: true }).selectOption('leistungsorientiert');
  await page.getByRole('button', { name: 'Athlet speichern' }).click();

  const adultCard = page.locator('article').filter({ hasText: 'Max Test' });
  await adultCard.getByRole('link', { name: 'Bearbeiten' }).click();
  await page.getByLabel('Dokumentversion', { exact: true }).fill('v1.0');
  await page.getByRole('button', { name: 'Einwilligung erteilen' }).click();
  await expect(page.getByText(/DIAGNOSTIC_TESTING · v1.0 · GRANTED/)).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: 'Tests öffnen' }).click();
  const adultOption = page.locator('select[name="athleteId"] option').filter({ hasText: 'Max Test' });
  await expect(adultOption).toHaveCount(1);
  const adultId = await adultOption.getAttribute('value');
  expect(adultId).not.toBeNull();
  await page.locator('select[name="athleteId"]').selectOption(adultId!);
  await page.locator('select[name="protocolVersionId"]').selectOption({ index: 1 });
  await page.getByLabel('Erwartete LT2 (W)', { exact: true }).fill('350');
  await page.getByLabel('Stufenzahl', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Testplan erstellen' }).click();
  await page.waitForURL((url) => /^\/tests\/[^/]+$/.test(url.pathname));
  const testId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  expect(testId).toBeTruthy();

  await expect(page.getByRole('heading', { name: 'Sicherheitscheck vor dem Start' })).toBeVisible();
  const safetyItems = page.locator('.safety-checklist input[type="checkbox"]');
  await expect(safetyItems).toHaveCount(11);
  for (const checkbox of await safetyItems.all()) await checkbox.check();
  await page.getByRole('button', { name: 'Sicherheitscheck bestätigen' }).click();

  await expect(page.getByRole('heading', { name: 'Startbereit' })).toBeVisible();
  await page.getByRole('button', { name: 'Test starten' }).click();
  await expect(page.getByText('Bearbeitungssperre aktiv')).toBeVisible();
  await expect(page.getByText('Test läuft')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Warm-up' })).toBeVisible();

  let failNextMeasurementSync = true;
  await page.route('**/api/tests/**/measurements/sync', async (route) => {
    if (failNextMeasurementSync) {
      failNextMeasurementSync = false;
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });
  await page.getByLabel('Laktat (mmol/L)').fill('1,20');
  await page.getByLabel('Herzfrequenz (1/min)').fill('52');
  await page.getByRole('button', { name: 'Messwert lokal speichern' }).click();
  await expect(page.getByText(/Lokale Messwerte: Gespeichert/)).toBeVisible();
  await expect(page.getByText(/Server-Sync: Ausstehend/)).toBeVisible();

  await page.unroute('**/api/tests/**/measurements/sync');
  const retriedRestSync = page.waitForResponse(
    (response) => response.url().includes('/measurements/sync')
      && response.request().method() === 'POST',
  );
  await page.reload();
  await expect(page.getByText('Bearbeitungssperre aktiv')).toBeVisible();
  expect((await retriedRestSync).ok()).toBe(true);
  await expect(page.getByText(/Server-Sync: Synchronisiert/)).toBeVisible();
  await expect(page.getByLabel('Laktat (mmol/L)')).toHaveValue('1,2');
  await expect(page.getByLabel('Herzfrequenz (1/min)')).toHaveValue('52');

  await page.getByLabel('Messpunkt').selectOption('STAGE:1');
  await page.getByLabel('Laktat (mmol/L)').fill('2,40');
  await page.getByLabel('Qualifier').selectOption('LESS_THAN');
  await page.getByLabel('Herzfrequenz (1/min)').fill('128');
  const stageSync = page.waitForResponse(
    (response) => response.url().includes('/measurements/sync')
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Messwert lokal speichern' }).click();
  expect((await stageSync).ok()).toBe(true);
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Stufe 1 · Laktat < 2,4 mmol/L · HF 128' }),
  ).toBeVisible();
  await expect(page.getByText(/Server-Sync: Synchronisiert/)).toBeVisible();

  await page.getByLabel('Messpunkt').selectOption('RECOVERY');
  await page.getByLabel('Laktat (mmol/L)').fill('');
  await page.getByLabel('Herzfrequenz (1/min)').fill('88');
  const recoverySync = page.waitForResponse(
    (response) => response.url().includes('/measurements/sync')
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Messwert lokal speichern' }).click();
  expect((await recoverySync).ok()).toBe(true);
  await expect(
    page.getByRole('listitem').filter({ hasText: '5-Minuten-Erholung · Laktat — · HF 88' }),
  ).toBeVisible();
  await expect(page.getByText(/Server-Sync: Synchronisiert/)).toBeVisible();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Test pausiert')).toBeVisible();
  await expect(page.getByText(/Lokaler Timer: Gespeichert/)).toBeVisible();
  const pausedCountdown = await page.getByLabel('Countdown').textContent();
  await page.waitForTimeout(1_100);
  await expect(page.getByLabel('Countdown')).toHaveText(pausedCountdown ?? '');

  await page.reload();
  await expect(page.getByText('Test pausiert')).toBeVisible();
  await expect(page.getByLabel('Countdown')).toHaveText(pausedCountdown ?? '');
  await expect(page.getByText(/Lokaler Timer: Gespeichert/)).toBeVisible();
  await expect(page.getByText(/Lokale Messwerte: Gespeichert/)).toBeVisible();
  await expect(page.getByText(/Server-Sync: Synchronisiert/)).toBeVisible();
  await expect(page.getByLabel('Messpunkt')).toHaveValue('REST');
  await expect(page.getByLabel('Laktat (mmol/L)')).toHaveValue('1,2');
  await expect(page.getByLabel('Herzfrequenz (1/min)')).toHaveValue('52');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Stufe 1 · Laktat < 2,4 mmol/L · HF 128' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: '5-Minuten-Erholung · Laktat — · HF 88' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByText('Test läuft')).toBeVisible();

  await page.locator('select[name="reason"]').selectOption('TECHNICAL_FAILURE');
  await page.getByLabel('Vermerk').fill('E2E Testabbruch');
  await page.getByRole('button', { name: 'Test sofort abbrechen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Datenprüfung' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Messwerte prüfen und korrigieren' }),
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'Stufe 1' })
      .getByText('Dauer — / 04:00'),
  ).toBeVisible();

  await page.getByLabel('Laktat Stufe 1').fill('2,50');
  await page.getByLabel('Korrekturgrund Stufe 1')
    .fill('Kontrollmessung aus Papierprotokoll');
  const stageCorrection = page.waitForResponse(
    (response) => response.url().includes('/review/measurements')
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Stufe 1 speichern' }).click();
  expect((await stageCorrection).ok()).toBe(true);
  await expect(page.getByLabel('Qualität Stufe 1'))
    .toHaveValue('MANUALLY_CORRECTED');
  await expect(page.getByText('Gespeichert · Version 2')).toBeVisible();

  await page.getByLabel('Qualität Stufe 1').selectOption('EXCLUDED');
  await page.getByLabel('Korrekturgrund Stufe 1')
    .fill('Probe für Auswertung ausgeschlossen');
  await page.getByRole('button', { name: 'Stufe 1 speichern' }).click();
  await expect(page.getByLabel('Qualität Stufe 1')).toHaveValue('EXCLUDED');
  await expect(page.getByText('Gespeichert · Version 3')).toBeVisible();

  await page.getByLabel('Laktat Ruhewert').fill('1,30');
  await page.getByLabel('Korrekturgrund Ruhewert')
    .fill('Übertragungsfehler im Ruhewert korrigiert');
  await page.getByRole('button', { name: 'Ruhewert speichern' }).click();
  await expect(page.getByText('Gespeichert · Version 2')).toBeVisible();

  const releasedAt = new Date().toISOString();
  const interpretationId = crypto.randomUUID();
  await db.$client.execute({
    sql: 'UPDATE tests SET status = ?, released_at = ?, updated_at = ? WHERE id = ?',
    args: ['RELEASED', releasedAt, releasedAt, testId!],
  });
  await db.$client.execute({
    sql: `INSERT INTO interpretations (
      id, tenant_id, test_id, version_number, lt1_json, lt2_json, rationale,
      status, released_at, released_by_user_id, created_at, updated_at
    ) SELECT ?, tenant_id, id, 1, ?, ?, ?, 'RELEASED', ?, conducting_trainer_user_id, ?, ?
      FROM tests WHERE id = ?`,
    args: [
      interpretationId,
      JSON.stringify({ watts: 240 }),
      JSON.stringify({ watts: 350 }),
      'Freigegebene E2E-Interpretation',
      releasedAt,
      releasedAt,
      releasedAt,
      testId!,
    ],
  });

  await page.goto(`/tests/${testId}`);
  await expect(page.getByRole('heading', { name: 'Bericht' })).toBeVisible();
  const deGeneration = page.waitForResponse(
    (response) => response.url().endsWith(`/api/tests/${testId}/reports`)
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'PDF-Bericht erzeugen' }).click();
  const deResponse = await deGeneration;
  expect(deResponse.status()).toBe(201);
  const dePayload = await deResponse.json() as { downloadPath: string };
  await expect(page.getByRole('link', { name: 'PDF herunterladen' })).toBeVisible();
  const deDownload = await page.request.get(dePayload.downloadPath);
  expect(deDownload.ok()).toBe(true);
  expect(deDownload.headers()['content-type']).toContain('application/pdf');
  expect((await deDownload.body()).toString('latin1')).toContain('Leistungsdiagnostischer Bericht');

  await page.getByLabel('Sprache').selectOption('en');
  const enGeneration = page.waitForResponse(
    (response) => response.url().endsWith(`/api/tests/${testId}/reports`)
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'PDF-Bericht erzeugen' }).click();
  const enResponse = await enGeneration;
  expect(enResponse.status()).toBe(201);
  const enPayload = await enResponse.json() as { downloadPath: string };
  const enDownload = await page.request.get(enPayload.downloadPath);
  expect(enDownload.ok()).toBe(true);
  expect(enDownload.headers()['content-type']).toContain('application/pdf');
  expect((await enDownload.body()).toString('latin1')).toContain('Performance Diagnostic Report');

  await page.goto('/setup');
  await expectTenantAdminHome(page);
});