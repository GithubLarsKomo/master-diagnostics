import { expect, test, type Page } from '@playwright/test';

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

test('bootstraps a club and manages minor athlete consent and guardians', async ({ page }) => {
  test.setTimeout(90_000);
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
  await page.getByLabel('Disziplin', { exact: true }).fill('Einer');
  await page.getByLabel('Trainingsstatus', { exact: true }).fill('leistungsorientiert');
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
  await page.getByLabel('Disziplin', { exact: true }).fill('Einer');
  await page.getByLabel('Trainingsstatus', { exact: true }).fill('leistungsorientiert');
  await page.getByRole('button', { name: 'Athlet speichern' }).click();

  const adultCard = page.locator('article').filter({ hasText: 'Max Test' });
  await adultCard.getByRole('link', { name: 'Bearbeiten' }).click();
  await page.getByLabel('Dokumentversion', { exact: true }).fill('v1.0');
  await page.getByRole('button', { name: 'Einwilligung erteilen' }).click();
  await expect(page.getByText(/DIAGNOSTIC_TESTING · v1.0 · GRANTED/)).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: 'Tests öffnen' }).click();
  await page.getByLabel('Athlet', { exact: true }).selectOption({ label: 'Max Test' });
  await page.getByLabel('Protokoll', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Erwartete LT2 (W)', { exact: true }).fill('350');
  await page.getByLabel('Stufenzahl', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Testplan erstellen' }).click();

  await expect(page.getByRole('heading', { name: 'Sicherheitscheck vor dem Start' })).toBeVisible();
  const safetyItems = page.locator('.safety-checklist input[type="checkbox"]');
  await expect(safetyItems).toHaveCount(11);
  for (const checkbox of await safetyItems.all()) await checkbox.check();
  await page.getByRole('button', { name: 'Sicherheitscheck bestätigen' }).click();

  await expect(page.getByRole('heading', { name: 'Startbereit' })).toBeVisible();
  await page.getByRole('button', { name: 'Test starten' }).click();
  await expect(page.getByText('Test läuft')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Warm-up' })).toBeVisible();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Test pausiert')).toBeVisible();
  const pausedCountdown = await page.getByLabel('Countdown').textContent();
  await page.waitForTimeout(1_100);
  await expect(page.getByLabel('Countdown')).toHaveText(pausedCountdown ?? '');
  await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByText('Test läuft')).toBeVisible();

  await page.getByLabel('Abschluss- oder Abbruchgrund').selectOption('TECHNICAL_FAILURE');
  await page.getByLabel('Vermerk').fill('E2E Testabbruch');
  await page.getByRole('button', { name: 'Test sofort abbrechen' }).click();
  await expect(page.getByRole('heading', { name: 'Datenprüfung' })).toBeVisible();

  await page.goto('/setup');
  await expectTenantAdminHome(page);
});
