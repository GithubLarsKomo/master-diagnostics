import { expect, test, type Page } from '@playwright/test';
import { db } from '../src/lib/db';

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

async function releasedTestId(): Promise<string> {
  const result = await db.$client.execute({
    sql: `SELECT id FROM tests WHERE status = 'RELEASED' ORDER BY released_at DESC LIMIT 1`,
    args: [],
  });
  const id = result.rows[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error('No RELEASED E2E test fixture found');
  return id;
}

test('report and released-test policy states are assistively exposed', async ({ page }) => {
  await signIn(page);
  const testId = await releasedTestId();
  await page.goto(`/tests/${testId}`);
  await expect(page.getByRole('heading', { name: 'Bericht' })).toBeVisible();

  const analysisState = page.locator(
    'section[aria-labelledby="analysis-export-heading"] [role="status"], section[aria-labelledby="analysis-export-heading"] [role="alert"]',
  );
  await expect(analysisState).toHaveCount(1);
  await expect(analysisState).toBeVisible();

  await page.route('**/api/tests/**/reports', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'E2E-Bericht konnte nicht erzeugt werden' }),
    });
  });
  await page.getByRole('button', { name: 'PDF-Bericht erzeugen' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'E2E-Bericht konnte nicht erzeugt werden' })).toBeVisible();
  await page.unroute('**/api/tests/**/reports');

  const generation = page.waitForResponse(
    (response) => response.url().endsWith(`/api/tests/${testId}/reports`)
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'PDF-Bericht erzeugen' }).click();
  expect((await generation).status()).toBe(201);

  const reportStatus = page.getByRole('status').filter({ hasText: 'Bericht gespeichert.' });
  await expect(reportStatus).toBeVisible();
  await expect(reportStatus.getByRole('link', { name: 'PDF herunterladen' })).toBeVisible();
});
