import { expect, test, type Page } from '@playwright/test';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function auditSignIn(page: Page) {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByLabel('E-Mail', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Passwort', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `Horizontal page overflow at 320 CSS px on ${page.url()}`).toBeLessThanOrEqual(1);

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const focused = new Set<string>();
  let visibleFocus = 0;
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    const snapshot = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        key: `${element.tagName}:${element.id}:${element.getAttribute('name') ?? ''}`,
        visible: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      };
    });
    if (snapshot) {
      focused.add(snapshot.key);
      if (snapshot.visible) visibleFocus += 1;
    }
  }
  expect(focused.size, 'Keyboard focus did not traverse sign-in controls').toBeGreaterThan(1);
  expect(visibleFocus, 'No visible focus indicator detected on sign-in').toBeGreaterThan(0);
}

test('WCAG core audit covers sign-in after Club bootstrap', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  await page.getByRole('button', { name: 'Abmelden' }).click();
  await page.waitForURL((url) => url.pathname === '/sign-in');

  await auditSignIn(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('heading', { name: 'Masters Diagnostics' })).toBeVisible();
});
