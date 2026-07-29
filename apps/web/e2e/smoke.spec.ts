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

test('bootstraps a club and manages athlete consent', async ({ page }) => {
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
  await page.getByLabel('Geburtsdatum', { exact: true }).fill('1992-04-18');
  await page.getByLabel('Referenzkategorie', { exact: true }).fill('Masters A');
  await page.getByLabel('Körpergröße (cm)', { exact: true }).fill('174');
  await page.getByLabel('Gewicht (kg)', { exact: true }).fill('68.5');
  await page.getByLabel('Disziplin', { exact: true }).fill('Einer');
  await page.getByLabel('Trainingsstatus', { exact: true }).fill('leistungsorientiert');
  await page.getByRole('button', { name: 'Athlet speichern' }).click();

  await page.getByRole('link', { name: 'Bearbeiten' }).click();
  await page.getByLabel('Dokumentversion', { exact: true }).fill('v1.0');
  await page.getByRole('button', { name: 'Einwilligung erteilen' }).click();
  await expect(page.getByText(/DIAGNOSTIC_TESTING · v1.0 · GRANTED/)).toBeVisible();

  await page.getByLabel('Widerrufsgrund', { exact: true }).fill('Auf Wunsch des Athleten');
  await page.getByRole('button', { name: 'Einwilligung widerrufen' }).click();
  await expect(page.getByRole('heading', { name: 'Nutzung gesperrt' })).toBeVisible();
  await expect(page.getByText(/DIAGNOSTIC_TESTING · v1.0 · WITHDRAWN/)).toBeVisible();

  await page.goto('/setup');
  await expectTenantAdminHome(page);
}
