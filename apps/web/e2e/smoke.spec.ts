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

test('bootstraps a fresh club and signs in the tenant admin', async ({ page }) => {
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

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page);
  await expectTenantAdminHome(page);

  await page.goto('/setup');
  await expectTenantAdminHome(page);
});
