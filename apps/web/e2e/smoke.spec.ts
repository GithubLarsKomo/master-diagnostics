import { expect, test } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

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

  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Masters Diagnostics' })).toBeVisible();
  await expect(page.getByText('TENANT_ADMIN')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tenant-Kontext' })).toBeVisible();

  await page.goto('/setup');
  await expect(page).toHaveURL(/\/$/);
});
