import { expect, test, type Page } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function signIn(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

test('blocked athletes are excluded from test planning and explained assistively', async ({ page }) => {
  await signIn(page);
  await page.goto('/tests');

  await expect(
    page.getByRole('status').filter({
      hasText: 'Einwilligungs- oder Löschsperre nicht für neue Tests auswählbar',
    }),
  ).toBeVisible();

  const athleteSelect = page.locator('select[name="athleteId"]');
  await expect(athleteSelect).toBeVisible();
  await expect(athleteSelect.locator('option').filter({ hasText: 'Petra Muster' })).toHaveCount(0);
  await expect(athleteSelect.locator('option').filter({ hasText: 'Max Test' })).toHaveCount(1);
});
