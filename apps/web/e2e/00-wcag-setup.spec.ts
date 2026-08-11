import { expect, test, type Page } from '@playwright/test';

async function auditPreAuthPage(page: Page) {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  const unnamed = await page.locator('button, a[href], input:not([type="hidden"]), select, textarea').evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const element = node as HTMLElement;
        if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const control = element as HTMLInputElement;
        const explicitLabel = element.id
          ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() ?? ''
          : '';
        const wrappedLabel = element.closest('label')?.textContent?.trim() ?? '';
        const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ')
          .trim();
        const name =
          element.getAttribute('aria-label')?.trim() ||
          labelledBy ||
          explicitLabel ||
          wrappedLabel ||
          element.textContent?.trim() ||
          ((control.type === 'submit' || control.type === 'button') ? control.value?.trim() : '') ||
          element.getAttribute('title')?.trim();
        return !name;
      })
      .map((node) => `${node.tagName.toLowerCase()}#${(node as HTMLElement).id || '-'}`),
  );
  expect(unnamed, `Unnamed interactive controls on ${page.url()}`).toEqual([]);

  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `Horizontal page overflow at 320 CSS px on ${page.url()}`).toBeLessThanOrEqual(1);

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const focused = new Set<string>();
  let visibleFocus = 0;
  for (let index = 0; index < 10; index += 1) {
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
  expect(focused.size, `Keyboard focus did not traverse ${page.url()}`).toBeGreaterThan(1);
  expect(visibleFocus, `No visible focus indicator on ${page.url()}`).toBeGreaterThan(0);
}

test('WCAG core audit covers pristine Club setup before bootstrap', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await auditPreAuthPage(page);
  await expect(page.getByLabel('Clubname', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Slug', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('E-Mail', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Passwort', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Installation abschließen' })).toBeVisible();
});
