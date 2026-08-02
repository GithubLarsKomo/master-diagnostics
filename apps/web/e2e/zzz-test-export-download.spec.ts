import { expect, test } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

test('downloads the released test in csv, json and markdown', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3000\/$/);
  const dashboardTask = page.getByRole('listitem').filter({ hasText: 'Max Test' });
  await dashboardTask.getByRole('link', { name: 'Öffnen', exact: true }).click();

  const cases = [
    { name: 'CSV exportieren', contentType: 'text/csv', contains: 'schemaVersion,masters-test-export-v1' },
    { name: 'JSON exportieren', contentType: 'application/json', contains: '"schemaVersion": "masters-test-export-v1"' },
    { name: 'Markdown exportieren', contentType: 'text/markdown', contains: '# Testexport' },
  ] as const;

  for (const item of cases) {
    const link = page.getByRole('link', { name: item.name });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();

    const response = await page.request.get(href!);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain(item.contentType);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(await response.text()).toContain(item.contains);
  }
});
