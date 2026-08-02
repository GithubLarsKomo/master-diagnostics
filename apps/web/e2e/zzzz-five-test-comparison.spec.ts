import { expect, test } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

test('shows the accessible athlete test comparison after the live workflow', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3000\/$/);

  await page.goto('/athletes');
  const athleteCard = page.locator('article').filter({ hasText: 'Max Test' });
  await athleteCard.getByRole('link', { name: 'Bearbeiten' }).click();
  await expect(page.getByRole('heading', { name: 'Sportdiagnostischer Verlauf' })).toBeVisible();
  const athleteUrl = new URL(page.url());

  await page.goto(`${athleteUrl.pathname}/curve`);
  await expect(page.getByRole('heading', { name: 'Laktatkurve' })).toBeVisible();
  await page.getByRole('link', { name: 'Bis zu fünf Tests vergleichen' }).click();

  await expect(page.getByRole('heading', { name: 'Testvergleich' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bis zu fünf aktuelle Tests' })).toBeVisible();

  const overview = page.getByRole('table', { name: 'Übersicht der verglichenen Tests' });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole('row')).toHaveCount(2);
  const referenceRow = overview.getByRole('row').nth(1);
  await expect(referenceRow).toContainText('Referenz');
  await expect(referenceRow).toContainText('2');
  await expect(referenceRow).toContainText('2.50–4.10 mmol/l');

  const values = page.getByRole('table', { name: 'Messwerte Test 1' });
  await expect(values).toBeVisible();
  await expect(values.getByRole('row')).toHaveCount(3);
  await expect(values.getByRole('row').filter({ hasText: '2.50 mmol/l' })).toBeVisible();
  await expect(values.getByRole('row').filter({ hasText: '4.10 mmol/l' })).toBeVisible();
});
