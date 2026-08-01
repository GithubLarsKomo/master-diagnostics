import { expect, test } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

test('shows the actionable trainer workload after the live workflow', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3000\/$/);
  await expect(page.getByText('Trainer-Dashboard')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Meine nächsten Aufgaben' })).toBeVisible();

  const summary = page.getByLabel('Aufgabenübersicht');
  await expect(summary.getByText('Offen gesamt')).toBeVisible();
  await expect(summary.getByText('1', { exact: true })).toHaveCount(2);
  await expect(summary.getByText('Laufende Tests')).toBeVisible();
  await expect(summary.getByText('Datenprüfung')).toBeVisible();
  await expect(summary.getByText('Vorbereitung')).toBeVisible();

  await expect(page.getByText('Max Test')).toBeVisible();
  await expect(page.getByText('Testdaten prüfen und auswerten')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Öffnen' })).toBeVisible();
});
