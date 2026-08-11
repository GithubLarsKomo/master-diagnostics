import { expect, test, type Page } from '@playwright/test';
import { db } from '../src/lib/db';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function signInIfNeeded(page: Page) {
  await page.goto('/');
  if (new URL(page.url()).pathname === '/setup') {
    await page.getByLabel('Clubname', { exact: true }).fill('WCAG Test Club');
    await page.getByLabel('Slug', { exact: true }).fill('wcag-test');
    await page.getByLabel('Name', { exact: true }).fill('Club Admin');
    await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Installation abschließen' }).click();
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/sign-in');
  }
  if (new URL(page.url()).pathname === '/sign-in') {
    await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }
}

async function auditAccessibleNames(page: Page) {
  const failures = await page.locator('button, a[href], input:not([type="hidden"]), select, textarea').evaluateAll((nodes) => {
    function referencedText(element: Element, idref: string | null) {
      if (!idref) return '';
      return idref.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
    }
    function labelText(element: Element) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return '';
      const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() ?? '' : '';
      const wrapped = element.closest('label')?.textContent?.trim() ?? '';
      return explicit || wrapped;
    }
    return nodes.filter((node) => {
      const element = node as HTMLElement;
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const input = element as HTMLInputElement;
      const name = [
        element.getAttribute('aria-label')?.trim() ?? '',
        referencedText(element, element.getAttribute('aria-labelledby')),
        labelText(element),
        element.getAttribute('alt')?.trim() ?? '',
        input.type === 'submit' || input.type === 'button' ? input.value?.trim() ?? '' : '',
        element.textContent?.trim() ?? '',
        element.getAttribute('title')?.trim() ?? '',
      ].find(Boolean);
      return !name;
    }).map((node) => `${node.tagName.toLowerCase()}#${(node as HTMLElement).id || '-'}[name=${node.getAttribute('name') ?? '-'}]`);
  });
  expect(failures, `Interactive elements without accessible name on ${page.url()}`).toEqual([]);
}

async function auditStructure(page: Page) {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const levels = await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index] - levels[index - 1], `Heading level skip on ${page.url()}`).toBeLessThanOrEqual(1);
  }
}

async function auditKeyboardAndFocus(page: Page) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen = new Set<string>();
  let visibleFocusCount = 0;
  for (let index = 0; index < 16; index += 1) {
    await page.keyboard.press('Tab');
    const snapshot = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        key: `${element.tagName}:${element.id}:${element.getAttribute('name') ?? ''}:${element.textContent?.trim().slice(0, 40) ?? ''}`,
        visible: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      };
    });
    if (snapshot) {
      seen.add(snapshot.key);
      if (snapshot.visible) visibleFocusCount += 1;
    }
  }
  expect(seen.size, `Keyboard focus did not traverse the page on ${page.url()}`).toBeGreaterThan(1);
  expect(visibleFocusCount, `No visible focus indicator detected on ${page.url()}`).toBeGreaterThan(0);
}

async function auditReflow(page: Page) {
  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `Horizontal page overflow at 320 CSS px on ${page.url()}`).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function auditPage(page: Page, path: string) {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/sign-in$/);
  await auditAccessibleNames(page);
  await auditStructure(page);
  await auditKeyboardAndFocus(page);
  await auditReflow(page);
}

test('WCAG 2.2 AA core browser contract for stable club beta surfaces', async ({ page }) => {
  await signInIfNeeded(page);
  await auditPage(page, '/');
  await auditPage(page, '/athletes');
  await auditPage(page, '/tests');

  const result = await db.$client.execute({ sql: 'SELECT id FROM tests ORDER BY created_at DESC LIMIT 1', args: [] });
  const testId = result.rows[0]?.id;
  expect(typeof testId, 'The WCAG contract requires an existing E2E test to cover the test detail/review surface').toBe('string');
  await auditPage(page, `/tests/${String(testId)}`);
});
