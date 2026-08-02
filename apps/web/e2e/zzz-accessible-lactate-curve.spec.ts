import { expect, test } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

test('renders the lactate curve with an equivalent data table', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3000\/$/);
  const dashboardTask = page.getByRole('listitem').filter({ hasText: 'Max Test' });
  await dashboardTask.getByRole('link', { name: 'Öffnen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Messwerte prüfen und korrigieren' })).toBeVisible();

  await page.getByLabel('Qualität Stufe 1').selectOption('MANUALLY_CORRECTED');
  await page.getByLabel('Korrekturgrund Stufe 1').fill('Stufe für Kurvenvergleich wieder aufgenommen');
  await page.getByRole('button', { name: 'Stufe 1 speichern' }).click();
  await expect(page.getByLabel('Qualität Stufe 1')).toHaveValue('MANUALLY_CORRECTED');

  await page.getByLabel('Laktat Stufe 2').fill('4,10');
  await page.getByLabel('Herzfrequenz Stufe 2').fill('145');
  await page.getByLabel('Qualität Stufe 2').selectOption('MANUALLY_CORRECTED');
  await page.getByLabel('Korrekturgrund Stufe 2').fill('Papierprotokoll für Kurvenprüfung nachgetragen');
  await page.getByRole('button', { name: 'Stufe 2 speichern' }).click();
  await expect(page.getByLabel('Qualität Stufe 2')).toHaveValue('MANUALLY_CORRECTED');

  await page.goto('/athletes');
  const athleteCard = page.locator('article').filter({ hasText: 'Max Test' });
  await athleteCard.getByRole('link', { name: 'Bearbeiten' }).click();
  await expect(page.getByRole('heading', { name: 'Sportdiagnostischer Verlauf' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Aktuelle Laktatkurve öffnen' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Bis zu fünf Tests vergleichen' })).toBeVisible();
  await expect(page.getByText('Kurven verfügbar')).toBeVisible();
  await expect(page.getByText('Berichtsversionen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Berichte' })).toBeVisible();

  const athleteUrl = new URL(page.url());
  await page.getByRole('link', { name: 'Aktuelle Laktatkurve öffnen' }).click();
  await expect(page).toHaveURL(`${athleteUrl.origin}${athleteUrl.pathname}/curve`);
  await expect(page.getByRole('heading', { name: 'Laktatkurve' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Laktat-Leistungs-Kurve des aktuellsten Tests' })).toBeVisible();
  await expect(page.locator('desc#curve-desc')).toHaveText('Laktatwerte in Millimol pro Liter über der Leistung in Watt. Die exakten Werte stehen zusätzlich in der Tabelle unterhalb der Grafik.');

  const table = page.getByRole('table', { name: 'Messwerte der Laktatkurve' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').filter({ hasText: '2.50 mmol/l' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: '4.10 mmol/l' })).toBeVisible();
});
