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

test('bootstraps a club and manages a tenant-scoped athlete', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Club einrichten' })).toBeVisible();

  await page.getByLabel('Clubname', { exact: true }).fill('Ratzeburger Ruderclub');
  await page.getByLabel('Slug', { exact: true }).fill('rrc');
  await page.getByLabel('Name', { exact: true }).fill('Club Admin');
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Installation abschließen' }).click();

  await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/sign-in');
  if (new URL(page.url()).pathname === '/sign-in') {
    await signIn(page);
  }
  await expectTenantAdminHome(page);

  await page.getByRole('link', { name: 'Athleten öffnen' }).click();
  await expect(page).toHaveURL(/\/athletes$/);
  await page.getByLabel('Vorname', { exact: true }).fill('Petra');
  await page.getByLabel('Nachname', { exact: true }).fill('Muster');
  await page.getByLabel('Geburtsdatum', { exact: true }).fill('1992-04-18');
  await page.getByLabel('Referenzkategorie', { exact: true }).fill('Masters A');
  await page.getByLabel('Körpergröße (cm)', { exact: true }).fill('174');
  await page.getByLabel('Gewicht (kg)', { exact: true }).fill('68.5');
  await page.getByLabel('Disziplin', { exact: true }).fill('Einer');
  await page.getByLabel('Trainingsstatus', { exact: true }).fill('leistungsorientiert');
  await page.getByRole('button', { name: 'Athlet speichern' }).click();

  await expect(page.getByRole('heading', { name: 'Petra Muster' })).toBeVisible();
  await page.getByRole('link', { name: 'Bearbeiten' }).click();
  await expect(page.getByRole('heading', { name: 'Athlet bearbeiten' })).toBeVisible();
  await page.getByLabel('Gewicht (kg)', { exact: true }).fill('69.25');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(page.getByText('174 cm · 69,25 kg')).toBeVisible();

  await page.goto('/setup');
  await expectTenantAdminHome(page);

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page);
  await expectTenantAdminHome(page);
});
